import Database from "bun:sqlite";
import { resolve } from "path";
import { ensureDataDir } from "./paths";
import { metrics } from "./metrics";

const dataDir = ensureDataDir();
const dbPath = resolve(dataDir, "overlord.db");
const db = new Database(dbPath);

const auditQueue: AuditLogEntry[] = [];
const BATCH_SIZE = 50;
const BATCH_INTERVAL_MS = 1000;
export const DEFAULT_AUDIT_MAX_ROWS = 250_000;
export const MAX_AUDIT_PRUNE_BATCH = 50_000;
const AUDIT_MAINTENANCE_EVERY_WRITES = 1_000;
const AUDIT_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
let flushTimeout: Timer | null = null;
let auditWritesSinceMaintenance = 0;

const VERBOSE_AUDIT = process.env.VERBOSE_AUDIT === "true";

db.run(`
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    username TEXT NOT NULL,
    ip TEXT NOT NULL,
    action TEXT NOT NULL,
    target_client_id TEXT,
    details TEXT,
    success INTEGER NOT NULL,
    error_message TEXT
  );
`);

db.run(
  `CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp DESC);`,
);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_audit_username ON audit_logs(username);`,
);
db.run(`CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);`);

export enum AuditAction {
  CLIENT_FIRST_CONNECT = "client_first_connect",
  CLIENT_RECONNECT = "client_reconnect",
  CLIENT_DISCONNECT = "client_disconnect",
  LOGIN = "login",
  LOGOUT = "logout",
  LOGIN_FAILED = "login_failed",
  COMMAND = "command",
  FILE_DOWNLOAD = "file_download",
  FILE_UPLOAD = "file_upload",
  FILE_DELETE = "file_delete",
  FILE_LIST = "file_list",
  FILE_MKDIR = "file_mkdir",
  FILE_READ = "file_read",
  FILE_WRITE = "file_write",
  FILE_SEARCH = "file_search",
  FILE_COPY = "file_copy",
  FILE_MOVE = "file_move",
  FILE_CHMOD = "file_chmod",
  FILE_EXECUTE = "file_execute",
  FILE_ZIP = "file_zip",
  CONSOLE_START = "console_start",
  CONSOLE_STOP = "console_stop",
  CONSOLE_INPUT = "console_input",
  DESKTOP_START = "desktop_start",
  DESKTOP_STOP = "desktop_stop",
  DESKTOP_MOUSE = "desktop_mouse",
  DESKTOP_KEYBOARD = "desktop_keyboard",
  PROCESS_LIST = "process_list",
  PROCESS_KILL = "process_kill",
  SCREENSHOT = "screenshot",
  DISCONNECT = "disconnect",
  RECONNECT = "reconnect",
  UNINSTALL = "uninstall",
  AGENT_UPDATE = "agent_update",
  SCRIPT_EXECUTE = "script_execute",
  SILENT_EXECUTE = "silent_execute",
  ENROLLMENT_APPROVE = "enrollment_approve",
  ENROLLMENT_DENY = "enrollment_deny",
  ENROLLMENT_SETTINGS = "enrollment_settings",
  ENROLLMENT_BULK = "enrollment_bulk",
  WINRE_INSTALL = "winre_install",
  WINRE_UNINSTALL = "winre_uninstall",
  PERMISSION_GROUP_CREATE = "permission_group_create",
  PERMISSION_GROUP_UPDATE = "permission_group_update",
  PERMISSION_GROUP_DELETE = "permission_group_delete",
  USER_GROUPS_CHANGE = "user_groups_change",
  USER_EXTRA_PERMISSIONS_CHANGE = "user_extra_permissions_change",
  USER_FEATURE_PERMISSIONS_CHANGE = "user_feature_permissions_change",
  USER_ROLE_CHANGE = "user_role_change",
  USER_BUILD_TOGGLE = "user_build_toggle",
  USER_UPLOAD_TOGGLE = "user_upload_toggle",
  USER_CHAT_WRITE_TOGGLE = "user_chat_write_toggle",
}

export interface AuditLogEntry {
  id?: number;
  timestamp: number;
  username: string;
  ip: string;
  action: AuditAction | string;
  targetClientId?: string;
  details?: string;
  success: boolean;
  errorMessage?: string;
}

export interface AuditLogFilters {
  page?: number;
  pageSize?: number;
  username?: string;
  action?: string;
  actions?: string[];
  targetClientId?: string;
  startDate?: number;
  endDate?: number;
  successOnly?: boolean;
  allowedClientIds?: string[];
  deniedClientIds?: string[];
}

function positiveAuditInt(name: string, fallback: number, maximum: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function boundedAuditText(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.slice(0, maxLength).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    : "";
}

function normalizeAuditEntry(entry: AuditLogEntry): AuditLogEntry {
  return {
    timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : Date.now(),
    username: boundedAuditText(entry.username, 128) || "unknown",
    ip: boundedAuditText(entry.ip, 128) || "unknown",
    action: boundedAuditText(entry.action, 128) || "unknown",
    ...(entry.targetClientId
      ? { targetClientId: boundedAuditText(entry.targetClientId, 128) || undefined }
      : {}),
    ...(entry.details ? { details: boundedAuditText(entry.details, 16 * 1024) || undefined } : {}),
    success: entry.success === true,
    ...(entry.errorMessage
      ? { errorMessage: boundedAuditText(entry.errorMessage, 4 * 1024) || undefined }
      : {}),
  };
}

export function logAudit(entry: AuditLogEntry): void {
  const normalized = normalizeAuditEntry(entry);
  auditQueue.push(normalized);

  if (VERBOSE_AUDIT) {
    const status = normalized.success ? "✓" : "✗";
    const target = normalized.targetClientId
      ? ` [client: ${normalized.targetClientId.substring(0, 8)}...]`
      : "";
    console.log(
      `[audit] ${status} ${normalized.username}@${normalized.ip} - ${normalized.action}${target}`,
    );
  }

  if (auditQueue.length >= BATCH_SIZE) {
    flushAuditLogs();
  } else if (!flushTimeout) {
    flushTimeout = setTimeout(flushAuditLogs, BATCH_INTERVAL_MS);
  }
}

function flushAuditLogs(): void {
  if (flushTimeout) {
    clearTimeout(flushTimeout);
    flushTimeout = null;
  }

  if (auditQueue.length === 0) return;

  const logsToWrite = auditQueue.splice(0, auditQueue.length);
  const startedAt = Date.now();

  try {
    const insert = db.prepare(
      `INSERT INTO audit_logs (timestamp, username, ip, action, target_client_id, details, success, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const transaction = db.transaction((logs: AuditLogEntry[]) => {
      for (const entry of logs) {
        insert.run(
          entry.timestamp,
          entry.username,
          entry.ip,
          entry.action,
          entry.targetClientId || null,
          entry.details || null,
          entry.success ? 1 : 0,
          entry.errorMessage || null,
        );
      }
    });

    transaction(logsToWrite);
    auditWritesSinceMaintenance += logsToWrite.length;
    if (auditWritesSinceMaintenance >= AUDIT_MAINTENANCE_EVERY_WRITES) {
      auditWritesSinceMaintenance = 0;
      runAuditMaintenance();
    }
    metrics.recordInternalTask("audit-flush", Date.now() - startedAt);
  } catch (error) {
    console.error(
      `[audit] Failed to flush ${logsToWrite.length} audit entries:`,
      error,
    );
  }
}

export function flushAuditLogsSync(): void {
  flushAuditLogs();
}

export function getAuditQueueStats(): { queued: number } {
  return { queued: auditQueue.length };
}

export function getAuditLogs(filters: AuditLogFilters = {}): {
  logs: AuditLogEntry[];
  total: number;
  page: number;
  pageSize: number;
} {
  const page = filters.page || 1;
  const pageSize = filters.pageSize || 50;
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const params: any[] = [];

  if (filters.username) {
    where.push("username = ?");
    params.push(filters.username);
  }

  if (filters.action) {
    where.push("action = ?");
    params.push(filters.action);
  }

  if (filters.actions && filters.actions.length > 0) {
    const placeholders = filters.actions.map(() => "?").join(", ");
    where.push(`action IN (${placeholders})`);
    params.push(...filters.actions);
  }

  if (filters.targetClientId) {
    where.push("target_client_id = ?");
    params.push(filters.targetClientId);
  }

  if (filters.startDate) {
    where.push("timestamp >= ?");
    params.push(filters.startDate);
  }

  if (filters.endDate) {
    where.push("timestamp <= ?");
    params.push(filters.endDate);
  }

  if (filters.successOnly) {
    where.push("success = 1");
  }

  if (filters.allowedClientIds) {
    if (filters.allowedClientIds.length === 0) {
      return { logs: [], total: 0, page, pageSize };
    }
    const placeholders = filters.allowedClientIds.map(() => "?").join(",");
    where.push(`(target_client_id IN (${placeholders}) OR target_client_id IS NULL)`);
    params.push(...filters.allowedClientIds);
  } else if (filters.deniedClientIds && filters.deniedClientIds.length > 0) {
    const placeholders = filters.deniedClientIds.map(() => "?").join(",");
    where.push(`(target_client_id NOT IN (${placeholders}) OR target_client_id IS NULL)`);
    params.push(...filters.deniedClientIds);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const countQuery = `SELECT COUNT(*) as total FROM audit_logs ${whereSql}`;
  const countResult = db.query(countQuery).get(...params) as { total: number };
  const total = countResult?.total || 0;

  const logsQuery = `
    SELECT id, timestamp, username, ip, action, target_client_id, details, success, error_message
    FROM audit_logs
    ${whereSql}
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `;

  const logs = db.query(logsQuery).all(...params, pageSize, offset) as any[];

  return {
    logs: logs.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      username: row.username,
      ip: row.ip,
      action: row.action,
      targetClientId: row.target_client_id || undefined,
      details: row.details || undefined,
      success: row.success === 1,
      errorMessage: row.error_message || undefined,
    })),
    total,
    page,
    pageSize,
  };
}

export function getAuditStats(): {
  totalLogs: number;
  last24h: number;
  failedLogins: number;
  topUsers: Array<{ username: string; count: number }>;
  topActions: Array<{ action: string; count: number }>;
} {
  const now = Date.now();
  const yesterday = now - 24 * 60 * 60 * 1000;

  const totalLogs = (
    db.query("SELECT COUNT(*) as count FROM audit_logs").get() as any
  ).count;
  const last24h = (
    db
      .query("SELECT COUNT(*) as count FROM audit_logs WHERE timestamp >= ?")
      .get(yesterday) as any
  ).count;
  const failedLogins = (
    db
      .query(
        "SELECT COUNT(*) as count FROM audit_logs WHERE action = ? AND success = 0",
      )
      .get(AuditAction.LOGIN_FAILED) as any
  ).count;

  const topUsers = db
    .query(
      `
    SELECT username, COUNT(*) as count 
    FROM audit_logs 
    WHERE timestamp >= ?
    GROUP BY username 
    ORDER BY count DESC 
    LIMIT 5
  `,
    )
    .all(yesterday) as Array<{ username: string; count: number }>;

  const topActions = db
    .query(
      `
    SELECT action, COUNT(*) as count 
    FROM audit_logs 
    WHERE timestamp >= ?
    GROUP BY action 
    ORDER BY count DESC 
    LIMIT 10
  `,
    )
    .all(yesterday) as Array<{ action: string; count: number }>;

  return {
    totalLogs,
    last24h,
    failedLogins,
    topUsers,
    topActions,
  };
}

export function cleanupOldAuditLogs(daysToKeep: number = 90): number {
  const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
  const result = db.run("DELETE FROM audit_logs WHERE timestamp < ?", [
    cutoffTime,
  ]);
  const deleted = result.changes;

  if (deleted > 0) {
    console.log(
      `[audit] Cleaned up ${deleted} audit logs older than ${daysToKeep} days`,
    );
  }

  return deleted;
}

export function pruneAuditRowsToLimit(
  database: Database,
  maxRows: number,
  maxBatch = MAX_AUDIT_PRUNE_BATCH,
): number {
  const safeMaxRows = Math.max(1, Math.floor(maxRows));
  const safeBatch = Math.max(1, Math.floor(maxBatch));
  const total = Number(
    (database.query("SELECT COUNT(*) AS count FROM audit_logs").get() as { count?: number } | null)?.count || 0,
  );
  const deleteCount = Math.min(safeBatch, Math.max(0, total - safeMaxRows));
  if (deleteCount === 0) return 0;
  return database.run(
    `DELETE FROM audit_logs WHERE id IN (
       SELECT id FROM audit_logs ORDER BY timestamp ASC, id ASC LIMIT ?
     )`,
    [deleteCount],
  ).changes;
}

export function runAuditMaintenance(): void {
  try {
    const retentionSetting = String(process.env.OVERLORD_AUDIT_RETENTION_DAYS || "").trim();
    if (retentionSetting) {
      cleanupOldAuditLogs(positiveAuditInt("OVERLORD_AUDIT_RETENTION_DAYS", 90, 3_650));
    }
    const maxRowsSetting = String(process.env.OVERLORD_AUDIT_MAX_ROWS || "").trim();
    if (maxRowsSetting) {
      const maxRows = positiveAuditInt(
        "OVERLORD_AUDIT_MAX_ROWS",
        DEFAULT_AUDIT_MAX_ROWS,
        10_000_000,
      );
      const deleted = pruneAuditRowsToLimit(db, maxRows);
      if (deleted > 0) {
        console.log(`[audit] Pruned ${deleted} oldest rows to enforce the ${maxRows} row cap`);
      }
    }
  } catch (error) {
    console.error("[audit] Maintenance failed:", error);
  }
}

setTimeout(runAuditMaintenance, 5_000).unref?.();
setInterval(runAuditMaintenance, AUDIT_MAINTENANCE_INTERVAL_MS).unref?.();

process.on("beforeExit", () => {
  flushAuditLogs();
});

process.on("SIGINT", () => {
  flushAuditLogs();
  process.exit(0);
});

process.on("SIGTERM", () => {
  flushAuditLogs();
  process.exit(0);
});

console.log("[audit] Audit logging system initialized");
