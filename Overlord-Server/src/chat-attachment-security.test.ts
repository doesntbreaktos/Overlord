import { describe, expect, test } from "bun:test";
import Database from "bun:sqlite";

const chatServerUrl = new URL("../../plugins/chat/server.js", import.meta.url).href;
const chatModule = await import(chatServerUrl) as {
  default: {
    setup: (ctx: any) => void;
    onEvent: (ctx: any, clientId: string, event: string, payload: unknown) => void;
    rpc: {
      store_attachment: (ctx: any, params: unknown) => any;
      get_attachment: (ctx: any, params: unknown) => any;
    };
  };
  MAX_CHAT_ATTACHMENT_SIZE: number;
  MAX_CHAT_INCOMING_RATE_KEYS: number;
  MAX_CHAT_ROWS_PRUNED_PER_SCOPE: number;
  createChatMessageStore: (database: Database, quotaProvider: () => any) => (record: any) => any;
  detectChatRasterMime: (buf: Buffer) => string | null;
  getChatRuntimeStats: () => { incomingRateKeys: number };
  validateChatAttachment: (input: unknown) => any;
};

const {
  default: chatPlugin,
  MAX_CHAT_ATTACHMENT_SIZE,
  MAX_CHAT_INCOMING_RATE_KEYS,
  MAX_CHAT_ROWS_PRUNED_PER_SCOPE,
  createChatMessageStore,
  detectChatRasterMime,
  getChatRuntimeStats,
  validateChatAttachment,
} = chatModule;

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const GIF_1X1 = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64",
);
const JPEG_ENVELOPE = Buffer.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xd9,
]);
const WEBP_ENVELOPE = Buffer.from(
  "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89",
  "base64",
);
const APNG_ENVELOPE = (() => {
  const animationControl = Buffer.alloc(20);
  animationControl.writeUInt32BE(8, 0);
  animationControl.write("acTL", 4, "ascii");
  animationControl.writeUInt32BE(2, 8);
  return Buffer.concat([PNG_1X1.subarray(0, 33), animationControl, PNG_1X1.subarray(33)]);
})();

function payload(buf: Buffer, mime: string, name = "image") {
  return { name, mime, dataB64: buf.toString("base64") };
}

function insertionContext() {
  let inserts = 0;
  const broadcasts: unknown[] = [];
  const warnings: string[] = [];
  return {
    ctx: {
      db: {
        transaction: (fn: (record: unknown) => unknown) => fn,
        prepare: (sql: string) => ({
          get: () => ({ messages: 0, message_bytes: 0, attachment_bytes: 0 }),
          all: () => [],
          run: () => {
            if (/\bINSERT\b/i.test(sql)) inserts += 1;
            return { lastInsertRowid: inserts };
          },
        }),
      },
      broadcast: (_event: string, value: unknown) => broadcasts.push(value),
      log: { warn: (value: string) => warnings.push(value) },
    },
    get inserts() { return inserts; },
    broadcasts,
    warnings,
  };
}

const GENEROUS_CHAT_STORAGE_LIMITS = {
  perClientMessages: 100_000,
  perClientMessageBytes: 1024 * 1024 * 1024,
  perClientAttachmentBytes: 1024 * 1024 * 1024,
  globalMessages: 100_000,
  globalMessageBytes: 1024 * 1024 * 1024,
  globalAttachmentBytes: 1024 * 1024 * 1024,
};

function chatRecord(clientId: string, timestamp: number, text = "hello") {
  return {
    clientId,
    sender: "Client",
    direction: "from_target",
    text,
    timestamp,
  };
}

function chatStorageHarness(overrides: Record<string, number> = {}) {
  const database = new Database(":memory:");
  chatPlugin.setup({ db: database });
  const limits = { ...GENEROUS_CHAT_STORAGE_LIMITS, ...overrides };
  return {
    database,
    save: createChatMessageStore(database, () => limits),
  };
}

describe("chat raster attachment validation", () => {
  test("recognizes only bounded still-image raster envelopes", () => {
    expect(detectChatRasterMime(PNG_1X1)).toBe("image/png");
    expect(detectChatRasterMime(JPEG_ENVELOPE)).toBe("image/jpeg");
    expect(detectChatRasterMime(GIF_1X1)).toBeNull();
    expect(detectChatRasterMime(APNG_ENVELOPE)).toBeNull();
    expect(detectChatRasterMime(WEBP_ENVELOPE)).toBe("image/webp");
    expect(detectChatRasterMime(Buffer.from("<svg><script>alert(1)</script></svg>"))).toBeNull();
  });

  test("accepts valid raster bytes and canonicalizes metadata", () => {
    const result = validateChatAttachment(payload(PNG_1X1, "image/png", "folder/one.png"));
    expect(result.ok).toBe(true);
    expect(result.mime).toBe("image/png");
    expect(result.name).toBe("folder_one.png");
    expect(result.buf).toEqual(PNG_1X1);
  });

  test("forces active files to inert downloads and rejects image spoofing or invalid base64", () => {
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    expect(validateChatAttachment(payload(svg, "image/svg+xml")).mime).toBe("application/octet-stream");
    expect(validateChatAttachment(payload(svg, "image/png")).ok).toBe(false);
    expect(validateChatAttachment(payload(PNG_1X1, "image/jpeg")).error).toMatch(/MIME/i);
    expect(validateChatAttachment(payload(Buffer.concat([JPEG_ENVELOPE, Buffer.from("<html>")]), "image/jpeg")).ok).toBe(false);
    expect(validateChatAttachment({ mime: "image/png", dataB64: "abcd!!!!" }).ok).toBe(false);
  });

  test("rejects encoded payloads above the server-side limit", () => {
    const tooLong = "A".repeat(Math.ceil(MAX_CHAT_ATTACHMENT_SIZE / 3) * 4 + 4);
    const result = validateChatAttachment({ mime: "image/png", dataB64: tooLong });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/64 MB/);

    // MAX + 1 happens to have the same base64 character count as MAX, so this
    // also verifies the decoded-byte check rather than only the string guard.
    const decodedOversize = Buffer.alloc(MAX_CHAT_ATTACHMENT_SIZE + 1).toString("base64");
    const decodedResult = validateChatAttachment({ mime: "image/png", dataB64: decodedOversize });
    expect(decodedResult.ok).toBe(false);
    expect(decodedResult.error).toMatch(/64 MB/);
  });

  test("drops an unsafe fake-client event before database insertion or broadcast", () => {
    const state = insertionContext();
    chatPlugin.onEvent(
      state.ctx,
      "fake-client",
      "chat_attachment",
      payload(Buffer.from("<html><script>alert(1)</script></html>"), "image/png"),
    );
    expect(state.inserts).toBe(0);
    expect(state.broadcasts).toHaveLength(0);
    expect(state.warnings).toHaveLength(1);
  });

  test("stores and broadcasts a verified fake-client raster attachment", () => {
    const state = insertionContext();
    chatPlugin.onEvent(
      state.ctx,
      "client-1",
      "chat_attachment",
      { ...payload(PNG_1X1, "image/png", "shot.png"), from: "Client" },
    );
    expect(state.inserts).toBe(1);
    expect(state.broadcasts).toHaveLength(1);
    expect(state.broadcasts[0]).toMatchObject({
      clientId: "client-1",
      attachment: { name: "shot.png", mime: "image/png", size: PNG_1X1.length },
    });
  });

  test("operator RPC stores active formats as inert downloads", () => {
    const state = insertionContext();
    const result = chatPlugin.rpc.store_attachment(
      state.ctx,
      {
        ...payload(Buffer.from("<!doctype html><script>alert(1)</script>"), "text/html"),
        clientId: "client-a",
        sender: "Operator",
      },
    );
    expect(result.ok).toBe(true);
    expect(result.mime).toBe("application/octet-stream");
    expect(state.inserts).toBe(1);
  });

  test("serves an unsafe legacy database row only as an inert download", () => {
    const svg = Buffer.from("<svg><script>alert(1)</script></svg>");
    const ctx = {
      db: {
        prepare: () => ({
          get: () => ({
            attachment_name: "legacy.svg",
            attachment_mime: "image/svg+xml",
            attachment_data: svg,
          }),
        }),
      },
    };
    const result = chatPlugin.rpc.get_attachment(ctx, { id: 1, clientId: "client-a" });
    expect(result).toEqual({
      ok: true,
      name: "legacy.svg",
      mime: "application/octet-stream",
      dataB64: svg.toString("base64"),
    });
  });
});

describe("chat fleet storage quotas", () => {
  test("prunes the oldest message across distinct client identities", () => {
    const { database, save } = chatStorageHarness({ globalMessages: 2 });
    try {
      expect(save(chatRecord("client-a", 1)).ok).toBe(true);
      expect(save(chatRecord("client-b", 2)).ok).toBe(true);
      expect(save(chatRecord("client-c", 3)).ok).toBe(true);
      expect(database.query(
        "SELECT client_id FROM messages ORDER BY timestamp",
      ).all()).toEqual([{ client_id: "client-b" }, { client_id: "client-c" }]);
    } finally {
      database.close();
    }
  });

  test("enforces fleet attachment bytes across distinct clients", () => {
    const { database, save } = chatStorageHarness({ globalAttachmentBytes: 10 });
    try {
      expect(save({
        ...chatRecord("client-a", 1, ""),
        attachmentName: "a.png",
        attachmentMime: "image/png",
        attachmentData: Buffer.alloc(6, 1),
      }).ok).toBe(true);
      expect(save({
        ...chatRecord("client-b", 2, ""),
        attachmentName: "b.png",
        attachmentMime: "image/png",
        attachmentData: Buffer.alloc(6, 2),
      }).ok).toBe(true);
      expect(database.query(
        "SELECT client_id, length(attachment_data) AS bytes FROM messages",
      ).all()).toEqual([{ client_id: "client-b", bytes: 6 }]);
    } finally {
      database.close();
    }
  });

  test("accounts UTF-8 bytes in legacy text-typed attachment rows", () => {
    const { database, save } = chatStorageHarness({ globalAttachmentBytes: 5 });
    try {
      database.prepare(
        `INSERT INTO messages
          (client_id, sender, direction, text, timestamp, attachment_data)
         VALUES ('legacy', 'Client', 'from_target', '', 1, ?)`,
      ).run("界");
      expect(save({
        ...chatRecord("incoming", 2, ""),
        attachmentName: "incoming.png",
        attachmentMime: "image/png",
        attachmentData: Buffer.alloc(3, 1),
      }).ok).toBe(true);
      expect(database.query(
        "SELECT client_id FROM messages",
      ).all()).toEqual([{ client_id: "incoming" }]);
    } finally {
      database.close();
    }
  });

  test("accounts UTF-8 message payload bytes independently of row count", () => {
    const { database, save } = chatStorageHarness({ globalMessageBytes: 160 });
    try {
      const text = "界".repeat(20);
      expect(save(chatRecord("a", 1, text)).ok).toBe(true);
      expect(save(chatRecord("b", 2, text)).ok).toBe(true);
      expect(database.query(
        "SELECT client_id FROM messages",
      ).all()).toEqual([{ client_id: "b" }]);
    } finally {
      database.close();
    }
  });

  test("commits a bounded global cleanup batch and converges on a later attempt", () => {
    const { database, save } = chatStorageHarness({ globalMessages: 1 });
    try {
      const insert = database.prepare(
        `INSERT INTO messages(client_id, sender, direction, text, timestamp)
         VALUES (?, 'Client', 'from_target', 'old', ?)`,
      );
      database.transaction(() => {
        for (let i = 0; i < MAX_CHAT_ROWS_PRUNED_PER_SCOPE + 2; i += 1) {
          insert.run(`legacy-${i}`, i);
        }
      })();

      expect(save(chatRecord("incoming", 10_000)).ok).toBe(false);
      expect((database.query(
        "SELECT COUNT(*) AS count FROM messages",
      ).get() as { count: number }).count).toBe(2);
      expect(save(chatRecord("incoming", 10_000)).ok).toBe(true);
      expect(database.query(
        "SELECT client_id FROM messages",
      ).all()).toEqual([{ client_id: "incoming" }]);
    } finally {
      database.close();
    }
  });

  test("does not double-count rows pruned by client and fleet scopes", () => {
    const { database, save } = chatStorageHarness({
      perClientMessages: 1,
      globalMessages: 1,
    });
    try {
      const insert = database.prepare(
        `INSERT INTO messages(client_id, sender, direction, text, timestamp)
         VALUES ('same-client', 'Client', 'from_target', 'old', ?)`,
      );
      database.transaction(() => {
        for (let i = 0; i < MAX_CHAT_ROWS_PRUNED_PER_SCOPE + 500; i += 1) {
          insert.run(i);
        }
      })();

      expect(save(chatRecord("same-client", 10_000)).ok).toBe(true);
      expect(database.query(
        "SELECT client_id, text FROM messages",
      ).all()).toEqual([{ client_id: "same-client", text: "hello" }]);
    } finally {
      database.close();
    }
  });

  test("rolls quota pruning back when the admitted insert fails", () => {
    const { database, save } = chatStorageHarness({ globalMessages: 1 });
    try {
      expect(save(chatRecord("retained", 1)).ok).toBe(true);
      database.exec(`
        CREATE TRIGGER reject_incoming_chat BEFORE INSERT ON messages
        WHEN new.client_id = 'incoming'
        BEGIN
          SELECT RAISE(ABORT, 'injected failure');
        END;
      `);

      expect(() => save(chatRecord("incoming", 2))).toThrow();
      expect(database.query(
        "SELECT client_id FROM messages",
      ).all()).toEqual([{ client_id: "retained" }]);
    } finally {
      database.close();
    }
  });

  test("does not retain per-identity rate metadata for compatible plugin traffic", () => {
    const prefix = `rate-${crypto.randomUUID()}`;
    for (let index = 0; index < MAX_CHAT_INCOMING_RATE_KEYS + 32; index += 1) {
      chatPlugin.onEvent({}, `${prefix}-${index}`, "chat_message", {});
    }
    expect(getChatRuntimeStats().incomingRateKeys).toBe(0);
  });
});

describe("chat browser attachment handling", () => {
  test("does not navigate attachment blobs as top-level documents", async () => {
    const source = await Bun.file(new URL("../../plugins/chat/chat.js", import.meta.url)).text();
    expect(source).not.toContain("window.open(");
    expect(source).toContain("SAFE_IMAGE_MIMES.has");
    expect(source).toContain("showImagePreview");
  });
});
