export const MAX_CHAT_ATTACHMENT_SIZE = 64 * 1024 * 1024;

const MAX_CHAT_ATTACHMENT_BASE64_SIZE = Math.ceil(MAX_CHAT_ATTACHMENT_SIZE / 3) * 4;
const SAFE_RASTER_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const MAX_CHAT_IMAGE_DIMENSION = 8192;
const MAX_CHAT_IMAGE_PIXELS = 16 * 1024 * 1024;
const MAX_CHAT_TEXT_LENGTH = 1024 * 1024;
const MAX_CHAT_MESSAGES_PER_CLIENT = 100_000;
const MAX_CHAT_MESSAGE_STORAGE_PER_CLIENT = 1024 * 1024 * 1024;
const MAX_CHAT_ATTACHMENT_STORAGE_PER_CLIENT = 10 * 1024 * 1024 * 1024;
const DEFAULT_MAX_CHAT_MESSAGES_GLOBAL = 1_000_000;
const DEFAULT_MAX_CHAT_MESSAGE_STORAGE_GLOBAL = 16 * 1024 * 1024 * 1024;
const DEFAULT_MAX_CHAT_ATTACHMENT_STORAGE_GLOBAL = 16 * 1024 * 1024 * 1024;
export const MAX_CHAT_ROWS_PRUNED_PER_SCOPE = 2_000;
export const MAX_CHAT_INCOMING_RATE_KEYS = 10_000;
const CHAT_MESSAGE_ROW_OVERHEAD_BYTES = 64;
const CHAT_MESSAGE_PAYLOAD_BYTES_SQL = `(
  ${CHAT_MESSAGE_ROW_OVERHEAD_BYTES}
  + COALESCE(length(CAST(client_id AS BLOB)), 0)
  + COALESCE(length(CAST(sender AS BLOB)), 0)
  + COALESCE(length(CAST(direction AS BLOB)), 0)
  + COALESCE(length(CAST(text AS BLOB)), 0)
  + COALESCE(length(CAST(attachment_name AS BLOB)), 0)
  + COALESCE(length(CAST(attachment_mime AS BLOB)), 0)
)`;
const incomingEventRates = new Map();
const chatMessageStores = new WeakMap();

function sanitizeChatText(value, maxLength = MAX_CHAT_TEXT_LENGTH) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function consumeIncomingEventRate(clientId, kind) {
  const now = Date.now();
  const isAttachment = kind === "attachment";
  const windowMs = isAttachment ? 10 * 60_000 : 60_000;
  const maxEvents = isAttachment ? 20 : 120;
  const key = `${clientId}:${kind}`;
  let state = incomingEventRates.get(key);
  if (!state || now - state.windowStart >= windowMs) {
    state = { windowStart: now, count: 0 };
  }
  state.count += 1;
  incomingEventRates.set(key, state);
  if (incomingEventRates.size > MAX_CHAT_INCOMING_RATE_KEYS) {
    for (const [rateKey, entry] of incomingEventRates) {
      if (now - entry.windowStart > 10 * 60_000) incomingEventRates.delete(rateKey);
    }
    while (incomingEventRates.size > MAX_CHAT_INCOMING_RATE_KEYS) {
      const oldestKey = incomingEventRates.keys().next().value;
      if (oldestKey === undefined) break;
      incomingEventRates.delete(oldestKey);
    }
  }
  return state.count <= maxEvents;
}

export function getChatRuntimeStats() {
  return { incomingRateKeys: incomingEventRates.size };
}

function positiveChatLimit(name, fallback, maximum) {
  const parsed = Number(process.env[name]);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

export function getChatStorageLimits() {
  return {
    perClientMessages: MAX_CHAT_MESSAGES_PER_CLIENT,
    perClientMessageBytes: MAX_CHAT_MESSAGE_STORAGE_PER_CLIENT,
    perClientAttachmentBytes: MAX_CHAT_ATTACHMENT_STORAGE_PER_CLIENT,
    globalMessages: positiveChatLimit(
      "OVERLORD_CHAT_PLUGIN_GLOBAL_MAX_MESSAGES",
      DEFAULT_MAX_CHAT_MESSAGES_GLOBAL,
      1_000_000,
    ),
    globalMessageBytes: positiveChatLimit(
      "OVERLORD_CHAT_PLUGIN_GLOBAL_MAX_MESSAGE_BYTES",
      DEFAULT_MAX_CHAT_MESSAGE_STORAGE_GLOBAL,
      16 * 1024 * 1024 * 1024,
    ),
    globalAttachmentBytes: positiveChatLimit(
      "OVERLORD_CHAT_PLUGIN_GLOBAL_MAX_ATTACHMENT_BYTES",
      DEFAULT_MAX_CHAT_ATTACHMENT_STORAGE_GLOBAL,
      16 * 1024 * 1024 * 1024,
    ),
  };
}

function optionalChatStringBytes(value) {
  return value ? Buffer.byteLength(value, "utf8") : 0;
}

function chatMessagePayloadBytes(record) {
  return CHAT_MESSAGE_ROW_OVERHEAD_BYTES
    + Buffer.byteLength(record.clientId, "utf8")
    + Buffer.byteLength(record.sender, "utf8")
    + Buffer.byteLength(record.direction, "utf8")
    + Buffer.byteLength(record.text, "utf8")
    + optionalChatStringBytes(record.attachmentName)
    + optionalChatStringBytes(record.attachmentMime);
}

function getChatStorageTotals(database, clientId) {
  const row = clientId === null
    ? database.prepare(
      `SELECT COUNT(*) AS messages,
              COALESCE(SUM(${CHAT_MESSAGE_PAYLOAD_BYTES_SQL}), 0) AS message_bytes,
              COALESCE(SUM(length(CAST(attachment_data AS BLOB))), 0) AS attachment_bytes
       FROM messages`,
    ).get()
    : database.prepare(
      `SELECT COUNT(*) AS messages,
              COALESCE(SUM(${CHAT_MESSAGE_PAYLOAD_BYTES_SQL}), 0) AS message_bytes,
              COALESCE(SUM(length(CAST(attachment_data AS BLOB))), 0) AS attachment_bytes
       FROM messages WHERE client_id = ?`,
    ).get(clientId);
  return {
    messages: Number(row?.messages || 0),
    messageBytes: Number(row?.message_bytes || 0),
    attachmentBytes: Number(row?.attachment_bytes || 0),
  };
}

function chatStorageScopeFits(database, clientId, incoming, limits) {
  const totals = getChatStorageTotals(database, clientId);
  return totals.messages + 1 <= limits.messages
    && totals.messageBytes + incoming.messageBytes <= limits.messageBytes
    && totals.attachmentBytes + incoming.attachmentBytes <= limits.attachmentBytes;
}

function deleteChatRows(database, ids) {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  database.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids);
}

function pruneChatStorageScope(database, clientId, incoming, limits) {
  const totals = getChatStorageTotals(database, clientId);
  let messages = totals.messages + 1;
  let messageBytes = totals.messageBytes + incoming.messageBytes;
  let attachmentBytes = totals.attachmentBytes + incoming.attachmentBytes;
  if (
    messages <= limits.messages
    && messageBytes <= limits.messageBytes
    && attachmentBytes <= limits.attachmentBytes
  ) return true;

  const rows = clientId === null
    ? database.prepare(
      `SELECT id, ${CHAT_MESSAGE_PAYLOAD_BYTES_SQL} AS message_bytes,
              COALESCE(length(CAST(attachment_data AS BLOB)), 0) AS attachment_bytes
       FROM messages ORDER BY timestamp ASC, id ASC LIMIT ?`,
    ).all(MAX_CHAT_ROWS_PRUNED_PER_SCOPE)
    : database.prepare(
      `SELECT id, ${CHAT_MESSAGE_PAYLOAD_BYTES_SQL} AS message_bytes,
              COALESCE(length(CAST(attachment_data AS BLOB)), 0) AS attachment_bytes
       FROM messages WHERE client_id = ?
       ORDER BY timestamp ASC, id ASC LIMIT ?`,
    ).all(clientId, MAX_CHAT_ROWS_PRUNED_PER_SCOPE);

  const pruneIds = [];
  for (const row of rows) {
    pruneIds.push(row.id);
    messages -= 1;
    messageBytes -= Number(row.message_bytes || 0);
    attachmentBytes -= Number(row.attachment_bytes || 0);
    if (
      messages <= limits.messages
      && messageBytes <= limits.messageBytes
      && attachmentBytes <= limits.attachmentBytes
    ) break;
  }
  deleteChatRows(database, pruneIds);
  return messages <= limits.messages
    && messageBytes <= limits.messageBytes
    && attachmentBytes <= limits.attachmentBytes;
}

export function createChatMessageStore(database, quotaProvider = getChatStorageLimits) {
  const transaction = database.transaction((record) => {
    const limits = quotaProvider();
    const incoming = {
      messageBytes: chatMessagePayloadBytes(record),
      attachmentBytes: record.attachmentData?.length || 0,
    };
    if (
      incoming.messageBytes > limits.perClientMessageBytes
      || incoming.messageBytes > limits.globalMessageBytes
      || incoming.attachmentBytes > limits.perClientAttachmentBytes
      || incoming.attachmentBytes > limits.globalAttachmentBytes
    ) return { ok: false, error: "chat storage quota exceeded" };

    let perClientSatisfied = pruneChatStorageScope(
      database,
      record.clientId,
      incoming,
      {
        messages: limits.perClientMessages,
        messageBytes: limits.perClientMessageBytes,
        attachmentBytes: limits.perClientAttachmentBytes,
      },
    );
    const globalSatisfied = pruneChatStorageScope(
      database,
      null,
      incoming,
      {
        messages: limits.globalMessages,
        messageBytes: limits.globalMessageBytes,
        attachmentBytes: limits.globalAttachmentBytes,
      },
    );
    if (!perClientSatisfied && globalSatisfied) {
      perClientSatisfied = chatStorageScopeFits(
        database,
        record.clientId,
        incoming,
        {
          messages: limits.perClientMessages,
          messageBytes: limits.perClientMessageBytes,
          attachmentBytes: limits.perClientAttachmentBytes,
        },
      );
    }
    if (!perClientSatisfied || !globalSatisfied) {
      return { ok: false, error: "chat storage quota exceeded" };
    }

    const info = database.prepare(
      `INSERT INTO messages
        (client_id, sender, direction, text, timestamp,
         attachment_name, attachment_mime, attachment_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.clientId,
      record.sender,
      record.direction,
      record.text,
      record.timestamp,
      record.attachmentName || null,
      record.attachmentMime || null,
      record.attachmentData || null,
    );
    return { ok: true, id: Number(info.lastInsertRowid), timestamp: record.timestamp };
  });
  return transaction;
}

function storeChatMessage(ctx, record) {
  let store = chatMessageStores.get(ctx.db);
  if (!store) {
    store = createChatMessageStore(ctx.db);
    chatMessageStores.set(ctx.db, store);
  }
  return store(record);
}

function bytesEqualAt(buf, offset, expected) {
  if (offset < 0 || offset + expected.length > buf.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (buf[offset + i] !== expected[i]) return false;
  }
  return true;
}

function imageDimensionsAllowed(width, height) {
  return Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_CHAT_IMAGE_DIMENSION &&
    height <= MAX_CHAT_IMAGE_DIMENSION &&
    width * height <= MAX_CHAT_IMAGE_PIXELS;
}

function readPngDimensions(buf) {
  if (!bytesEqualAt(buf, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return null;
  }
  let offset = 8;
  let dimensions = null;
  let sawImageData = false;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > buf.length) return null;

    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "acTL" || type === "fcTL" || type === "fdAT") return null;
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) return null;
      dimensions = { width: buf.readUInt32BE(offset + 8), height: buf.readUInt32BE(offset + 12) };
    } else if (type === "IDAT") {
      sawImageData = true;
    } else if (type === "IEND") {
      if (length !== 0 || chunkEnd !== buf.length || !sawImageData) return null;
      return dimensions;
    }
    offset = chunkEnd;
  }
  return null;
}

function readJpegDimensions(buf) {
  if (!bytesEqualAt(buf, 0, [0xff, 0xd8, 0xff]) || !bytesEqualAt(buf, buf.length - 2, [0xff, 0xd9])) {
    return null;
  }
  let offset = 2;
  while (offset + 4 <= buf.length - 2) {
    if (buf[offset] !== 0xff) return null;
    while (offset < buf.length && buf[offset] === 0xff) offset += 1;
    if (offset >= buf.length) return null;
    const marker = buf[offset++];
    if (marker === 0xd9) return null;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > buf.length) return null;
    const segmentLength = buf.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buf.length) return null;
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      if (segmentLength < 8) return null;
      return {
        width: buf.readUInt16BE(offset + 5),
        height: buf.readUInt16BE(offset + 3),
      };
    }
    // A valid JPEG provides its frame dimensions before scan data starts.
    if (marker === 0xda) return null;
    offset += segmentLength;
  }
  return null;
}

function readWebpDimensions(buf) {
  if (
    buf.length < 20 ||
    buf.subarray(0, 4).toString("ascii") !== "RIFF" ||
    buf.readUInt32LE(4) + 8 !== buf.length ||
    buf.subarray(8, 12).toString("ascii") !== "WEBP"
  ) return null;

  let offset = 12;
  let dimensions = null;
  while (offset + 8 <= buf.length) {
    const chunkType = buf.subarray(offset, offset + 4).toString("ascii");
    const chunkLength = buf.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const chunkEnd = dataOffset + chunkLength;
    if (chunkEnd > buf.length) return null;
    if (chunkType === "ANIM" || chunkType === "ANMF") return null;

    if (
      chunkType === "VP8 " &&
      chunkLength >= 10 &&
      bytesEqualAt(buf, dataOffset + 3, [0x9d, 0x01, 0x2a])
    ) {
      dimensions ??= {
        width: buf.readUInt16LE(dataOffset + 6) & 0x3fff,
        height: buf.readUInt16LE(dataOffset + 8) & 0x3fff,
      };
    }
    if (chunkType === "VP8L" && chunkLength >= 5 && buf[dataOffset] === 0x2f) {
      const packed = buf.readUInt32LE(dataOffset + 1);
      dimensions ??= {
        width: (packed & 0x3fff) + 1,
        height: ((packed >>> 14) & 0x3fff) + 1,
      };
    }
    if (chunkType === "VP8X" && chunkLength >= 10) {
      if ((buf[dataOffset] & 0x02) !== 0) return null;
      dimensions ??= {
        width: 1 + buf[dataOffset + 4] + (buf[dataOffset + 5] << 8) + (buf[dataOffset + 6] << 16),
        height: 1 + buf[dataOffset + 7] + (buf[dataOffset + 8] << 8) + (buf[dataOffset + 9] << 16),
      };
    }

    offset = chunkEnd + (chunkLength % 2);
  }
  return offset === buf.length ? dimensions : null;
}

export function detectChatRasterMime(buf) {
  if (!buf || typeof buf.length !== "number") return null;

  const pngDimensions = readPngDimensions(buf);
  if (pngDimensions && imageDimensionsAllowed(pngDimensions.width, pngDimensions.height)) {
    return "image/png";
  }

  const jpegDimensions = readJpegDimensions(buf);
  if (jpegDimensions && imageDimensionsAllowed(jpegDimensions.width, jpegDimensions.height)) {
    return "image/jpeg";
  }

  const webpDimensions = readWebpDimensions(buf);
  if (webpDimensions && imageDimensionsAllowed(webpDimensions.width, webpDimensions.height)) {
    return "image/webp";
  }

  return null;
}

function sanitizeAttachmentName(value) {
  const cleaned = String(value || "file")
    .replace(/[\\/\u0000-\u001f\u007f]/g, "_")
    .trim()
    .slice(0, 255);
  return cleaned || "file";
}

function validateChatAttachmentBytes(mimeValue, buf) {
  if (!buf || buf.length === 0) {
    return { ok: false, error: "empty attachment" };
  }
  if (buf.length > MAX_CHAT_ATTACHMENT_SIZE) {
    return { ok: false, error: "attachment exceeds 64 MB limit" };
  }

  const declaredMime = String(mimeValue || "").trim().toLowerCase();
  const detectedMime = detectChatRasterMime(buf);
  if (declaredMime && SAFE_RASTER_MIMES.has(declaredMime) && declaredMime !== detectedMime) {
    return { ok: false, error: "attachment MIME does not match its contents" };
  }

  // Unknown/active formats remain downloadable but are forced to an inert MIME.
  return { ok: true, mime: detectedMime || "application/octet-stream", buf };
}

export function validateChatAttachment(input) {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "invalid attachment payload" };
  }

  const dataB64 = input.dataB64;
  if (typeof dataB64 !== "string" || dataB64.length === 0) {
    return { ok: false, error: "empty attachment" };
  }
  if (dataB64.length > MAX_CHAT_ATTACHMENT_BASE64_SIZE) {
    return { ok: false, error: "attachment exceeds 64 MB limit" };
  }
  if (
    dataB64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(dataB64)
  ) {
    return { ok: false, error: "invalid base64 attachment" };
  }

  let buf;
  try {
    buf = Buffer.from(dataB64, "base64");
  } catch (_) {
    return { ok: false, error: "invalid base64 attachment" };
  }
  // Buffer's base64 decoder is intentionally permissive. Re-encoding makes
  // the accepted representation canonical and rejects ignored junk bytes.
  if (buf.toString("base64") !== dataB64) {
    return { ok: false, error: "invalid base64 attachment" };
  }

  const checked = validateChatAttachmentBytes(input.mime, buf);
  if (!checked.ok) return checked;
  return {
    ok: true,
    name: sanitizeAttachmentName(input.name),
    mime: checked.mime,
    buf: checked.buf,
  };
}

export default {
  setup(ctx) {
    ctx.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id   TEXT NOT NULL,
        sender      TEXT NOT NULL,
        direction   TEXT NOT NULL,
        text        TEXT NOT NULL,
        timestamp   INTEGER NOT NULL
      );
    `);
    try {
      ctx.db.exec(
        `CREATE INDEX IF NOT EXISTS msg_by_client ON messages(client_id, timestamp)`
      );
      ctx.db.exec(
        `CREATE INDEX IF NOT EXISTS msg_by_timestamp ON messages(timestamp, id)`
      );
    } catch (_) {}

    const cols = ctx.db
      .prepare(`PRAGMA table_info(messages)`)
      .all()
      .map((r) => r.name);
    if (!cols.includes("attachment_name")) {
      try {
        ctx.db.exec(`ALTER TABLE messages ADD COLUMN attachment_name TEXT`);
      } catch (_) {}
    }
    if (!cols.includes("attachment_mime")) {
      try {
        ctx.db.exec(`ALTER TABLE messages ADD COLUMN attachment_mime TEXT`);
      } catch (_) {}
    }
    if (!cols.includes("attachment_data")) {
      try {
        ctx.db.exec(`ALTER TABLE messages ADD COLUMN attachment_data BLOB`);
      } catch (_) {}
    }
    try {
      ctx.db.exec(
        `CREATE INDEX IF NOT EXISTS msg_attachments_by_client
         ON messages(client_id, timestamp, id) WHERE attachment_data IS NOT NULL`
      );
      ctx.db.exec(
        `CREATE INDEX IF NOT EXISTS msg_attachments_by_timestamp
         ON messages(timestamp, id) WHERE attachment_data IS NOT NULL`
      );
    } catch (_) {}
  },

  onEvent(ctx, clientId, event, payload) {
    if (event === "chat_message") {
      const text = sanitizeChatText(payload?.text);
      if (!text) return;
      const sender = sanitizeChatText(payload?.from || "Unknown", 128) || "Unknown";
      const ts = Date.now();
      const stored = storeChatMessage(ctx, {
        clientId,
        sender,
        direction: "from_target",
        text,
        timestamp: ts,
      });
      if (!stored.ok) {
        ctx.log?.warn?.(`Rejected chat message from ${clientId}: ${stored.error}`);
        return;
      }
      ctx.broadcast("new_message", {
        id: stored.id,
        clientId,
        sender,
        direction: "from_target",
        text,
        timestamp: ts,
      });
    }
    if (event === "chat_attachment") {
      const attachment = validateChatAttachment(payload);
      if (!attachment.ok) {
        ctx.log?.warn?.(`Rejected chat attachment from ${clientId}: ${attachment.error}`);
        return;
      }
      const ts = Date.now();
      const { name, mime, buf } = attachment;
      const sender = sanitizeChatText(payload?.from || "Unknown", 128) || "Unknown";
      const stored = storeChatMessage(ctx, {
        clientId,
        sender,
        direction: "from_target",
        text: "",
        timestamp: ts,
        attachmentName: name,
        attachmentMime: mime,
        attachmentData: buf,
      });
      if (!stored.ok) {
        ctx.log?.warn?.(`Rejected chat attachment from ${clientId}: ${stored.error}`);
        return;
      }
      ctx.broadcast("new_message", {
        id: stored.id,
        clientId,
        sender,
        direction: "from_target",
        text: "",
        timestamp: ts,
        attachment: { name, mime, size: buf.length },
      });
    }
    if (event === "chat_opened") {
      ctx.broadcast("chat_status", { clientId, status: "opened" });
    }
    if (event === "chat_closed") {
      ctx.broadcast("chat_status", { clientId, status: "closed" });
    }
  },

  rpc: {
    get_history(ctx, params) {
      return ctx.db
        .prepare(
          `SELECT id, client_id, sender, direction, text, timestamp,
                  attachment_name, attachment_mime,
                  CASE WHEN attachment_data IS NULL THEN 0 ELSE length(attachment_data) END AS attachment_size
           FROM messages WHERE client_id = ? ORDER BY timestamp ASC LIMIT 500`
        )
        .all(params.clientId)
        .map((r) => ({
          id: r.id,
          clientId: r.client_id,
          sender: r.sender,
          direction: r.direction,
          text: r.text,
          timestamp: r.timestamp,
          attachment: r.attachment_name
            ? {
                name: r.attachment_name,
                mime: r.attachment_mime,
                size: r.attachment_size,
              }
            : null,
        }));
    },

    get_attachment(ctx, params) {
      const clientId = String(params?.clientId || "").trim();
      if (!clientId) return { ok: false, error: "clientId required" };
      const row = ctx.db
        .prepare(
          `SELECT attachment_name, attachment_mime, attachment_data FROM messages WHERE id = ? AND client_id = ?`
        )
        .get(params.id, clientId);
      if (!row || !row.attachment_data) {
        return { ok: false, error: "not found" };
      }
      const buf = Buffer.isBuffer(row.attachment_data)
        ? row.attachment_data
        : Buffer.from(row.attachment_data);
      const checked = validateChatAttachmentBytes(row.attachment_mime, buf);
      if (!checked.ok) {
        return { ok: false, error: "unsafe attachment blocked" };
      }
      return {
        ok: true,
        name: sanitizeAttachmentName(row.attachment_name),
        mime: checked.mime,
        dataB64: buf.toString("base64"),
      };
    },

    store_message(ctx, params) {
      const clientId = String(params?.clientId || "").trim();
      const text = sanitizeChatText(params?.text);
      const sender = sanitizeChatText(params?.sender || "Operator", 128) || "Operator";
      if (!clientId || !text) return { ok: false, error: "invalid message" };
      const ts = Date.now();
      const stored = storeChatMessage(ctx, {
        clientId,
        sender,
        direction: "to_target",
        text,
        timestamp: ts,
      });
      if (!stored.ok) return stored;
      ctx.broadcast("new_message", {
        id: stored.id,
        clientId,
        sender,
        direction: "to_target",
        text,
        timestamp: ts,
      });
      return { ok: true, id: stored.id, timestamp: ts };
    },

    store_attachment(ctx, params) {
      const attachment = validateChatAttachment(params);
      if (!attachment.ok) {
        return { ok: false, error: attachment.error };
      }
      const ts = Date.now();
      const { name, mime, buf } = attachment;
      const clientId = String(params?.clientId || "").trim();
      if (!clientId) return { ok: false, error: "clientId required" };
      const sender = sanitizeChatText(params?.sender || "Operator", 128) || "Operator";
      const stored = storeChatMessage(ctx, {
        clientId,
        sender,
        direction: "to_target",
        text: "",
        timestamp: ts,
        attachmentName: name,
        attachmentMime: mime,
        attachmentData: buf,
      });
      if (!stored.ok) return stored;
      ctx.broadcast("new_message", {
        id: stored.id,
        clientId,
        sender,
        direction: "to_target",
        text: "",
        timestamp: ts,
        attachment: { name, mime, size: buf.length },
      });
      return {
        ok: true,
        id: stored.id,
        timestamp: ts,
        name,
        mime,
      };
    },

    clear_history(ctx, params) {
      ctx.db
        .prepare(`DELETE FROM messages WHERE client_id = ?`)
        .run(params.clientId);
      ctx.broadcast("history_cleared", { clientId: params.clientId });
      return { ok: true };
    },
  },
};
