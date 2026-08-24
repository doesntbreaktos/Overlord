import type { ServerWebSocket } from "bun";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import { v4 as uuidv4 } from "uuid";
import * as clientManager from "../clientManager";
import { saveNotification, getNotificationHistory } from "../db";
import { logger } from "../logger";
import { metrics } from "../metrics";
import { encodeMessage } from "../protocol";
import * as sessionManager from "../sessions/sessionManager";
import type { SocketData } from "../sessions/types";
import {
  deliverWebPushClientEvent,
  deliverClientEventToExternalChannels,
  validateNotificationScreenshotPayload,
  type UserDeliveryTarget,
} from "./notification-delivery";

type NotificationRecord = {
  id: string;
  clientId: string;
  host?: string;
  user?: string;
  os?: string;
  title: string;
  process?: string;
  processPath?: string;
  detail?: string;
  pid?: number;
  keyword?: string;
  category: "active_window" | "clipboard" | "crash_report";
  ts: number;
  screenshotId?: string;
};

type NotificationRateState = {
  lastSent: number;
  windowStart: number;
  suppressed: number;
  lastWarned: number;
};

type AntiSpamState = {
  hits: number;
  windowStart: number;
  blockedUntil: number;
};

export type PendingNotificationScreenshot = {
  notificationId: string;
  clientId: string;
  ts: number;
  timeout: NodeJS.Timeout;
};

type NotificationConfigShape = {
  minIntervalMs?: number;
  spamWindowMs?: number;
  spamWarnThreshold?: number;
  historyLimit?: number;
  antiSpamMaxHits?: number;
  antiSpamWindowMs?: number;
  antiSpamCooldownMs?: number;
};

const MAX_NOTIFICATION_TITLE_LENGTH = 512;
const MAX_NOTIFICATION_KEYWORD_LENGTH = 128;
const MAX_NOTIFICATION_PROCESS_LENGTH = 256;
const MAX_NOTIFICATION_PATH_LENGTH = 2_048;
export const MAX_PENDING_NOTIFICATION_SCREENSHOTS = 1_000;
export const MAX_PENDING_NOTIFICATION_SCREENSHOTS_PER_CLIENT = 2;
const MAX_PENDING_NOTIFICATION_SCREENSHOT_AGE_MS = 30_000;

// Exported for the audit regression tests that document the stricter event
// policy we intentionally rolled back for plugin compatibility. These limits
// are no longer applied to plugin traffic.
export const MAX_PLUGIN_EVENT_PAYLOAD_BYTES = 256 * 1024;
export const MAX_PLUGIN_EVENTS_PER_KEY_PER_MINUTE = 120;
export const MAX_BUFFERED_PLUGIN_EVENT_BYTES_PER_KEY = 8 * 1024 * 1024;
export const MAX_BUFFERED_PLUGIN_EVENT_BYTES_PER_CLIENT = 16 * 1024 * 1024;
export const MAX_BUFFERED_PLUGIN_EVENT_BYTES_GLOBAL = 64 * 1024 * 1024;

export function hasPluginUIEventBufferCapacity(
  keyBytes: number,
  clientBytes: number,
  globalBytes: number,
  incomingBytes: number,
): boolean {
  return incomingBytes >= 0
    && keyBytes + incomingBytes <= MAX_BUFFERED_PLUGIN_EVENT_BYTES_PER_KEY
    && clientBytes + incomingBytes <= MAX_BUFFERED_PLUGIN_EVENT_BYTES_PER_CLIENT
    && globalBytes + incomingBytes <= MAX_BUFFERED_PLUGIN_EVENT_BYTES_GLOBAL;
}

export function isPlausibleChatAttachmentEventPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attachment = value as Record<string, unknown>;
  const dataB64 = attachment.dataB64;
  const mime = typeof attachment.mime === "string" ? attachment.mime.trim().toLowerCase() : "";
  return typeof dataB64 === "string"
    && dataB64.length > 0
    && dataB64.length <= Math.ceil((5 * 1024 * 1024) / 3) * 4
    && dataB64.length % 4 === 0
    && /^[A-Za-z0-9+/]*={0,2}$/.test(dataB64)
    && new Set(["image/png", "image/jpeg", "image/webp"]).has(mime);
}

export function hasPendingNotificationScreenshotCapacity(
  pendingScreenshots: Map<string, PendingNotificationScreenshot>,
  clientId: string,
  now = Date.now(),
): boolean {
  let clientCount = 0;
  for (const [commandId, pending] of pendingScreenshots) {
    if (now - pending.ts > MAX_PENDING_NOTIFICATION_SCREENSHOT_AGE_MS) {
      clearTimeout(pending.timeout);
      pendingScreenshots.delete(commandId);
      continue;
    }
    if (pending.clientId === clientId) clientCount += 1;
  }
  return pendingScreenshots.size < MAX_PENDING_NOTIFICATION_SCREENSHOTS
    && clientCount < MAX_PENDING_NOTIFICATION_SCREENSHOTS_PER_CLIENT;
}

function sanitizeNotificationText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function normalizeClientNotificationPayload(
  payload: any,
): Omit<NotificationRecord, "id" | "clientId" | "host" | "user" | "os" | "ts"> | null {
  const title = sanitizeNotificationText(payload?.title, MAX_NOTIFICATION_TITLE_LENGTH);
  if (!title) return null;

  const rawPid = Number(payload?.pid);
  const pid = Number.isSafeInteger(rawPid) && rawPid > 0 && rawPid <= 0xffff_ffff
    ? rawPid
    : undefined;

  return {
    title,
    process: sanitizeNotificationText(payload?.process, MAX_NOTIFICATION_PROCESS_LENGTH),
    processPath: sanitizeNotificationText(payload?.processPath, MAX_NOTIFICATION_PATH_LENGTH),
    pid,
    keyword: sanitizeNotificationText(payload?.keyword, MAX_NOTIFICATION_KEYWORD_LENGTH),
    category: payload?.category === "clipboard" ? "clipboard" : "active_window",
  };
}

type CreateDeps = {
  notificationRate: Map<string, NotificationRateState>;
  pendingNotificationScreenshots: Map<string, PendingNotificationScreenshot>;
  pluginLoadedByClient: Map<string, Set<string>>;
  pluginLoadingByClient: Map<string, Set<string>>;
  pendingPluginEvents: Map<string, Array<{ event: string; payload: any }>>;
  pluginState: { enabled: Record<string, boolean>; lastError: Record<string, string> };
  getNotificationConfig: () => NotificationConfigShape;
  canUserAccessClient: (userId: number, userRole: string, clientId: string) => boolean;
  isClientOwnedByUser: (userId: number, clientId: string) => boolean;
  getUserRole: (userId: number) => string | undefined;
  isClientNotificationsMuted: (clientId: string) => boolean;
  storeNotificationScreenshot: (
    pending: PendingNotificationScreenshot,
    bytes: Uint8Array,
    format: string,
    width?: number,
    height?: number,
  ) => void;
  deliverNotificationWithScreenshot: (record: NotificationRecord) => Promise<void>;
  getDeliveryTargetsForClientEvent: (
    event: string,
    clientId: string,
  ) => UserDeliveryTarget[];
  savePluginState: () => Promise<void>;
  forwardPluginEventToRuntime?: (
    clientId: string,
    pluginId: string,
    event: string,
    payload: unknown,
  ) => void;
};

function safeSendViewer(ws: ServerWebSocket<SocketData>, payload: unknown) {
  try {
    ws.send(msgpackEncode(payload));
  } catch (err) {
    logger.error("[viewer] send failed", err);
  }
}

export function createNotificationPluginHandlers(deps: CreateDeps) {
  const antiSpamState = new Map<string, AntiSpamState>();
  const purgatoryExternalRates = new Map<string, { windowStart: number; count: number }>();
  let purgatoryGlobalRate = { windowStart: Date.now(), count: 0 };
  function allowPurgatoryExternalDelivery(ip: string | undefined): boolean {
    const now = Date.now();
    const windowMs = 60_000;
    if (now - purgatoryGlobalRate.windowStart >= windowMs) {
      purgatoryGlobalRate = { windowStart: now, count: 0 };
    }
    const key = String(ip || "unknown");
    let perIp = purgatoryExternalRates.get(key);
    if (!perIp || now - perIp.windowStart >= windowMs) {
      perIp = { windowStart: now, count: 0 };
    }
    purgatoryGlobalRate.count += 1;
    perIp.count += 1;
    purgatoryExternalRates.set(key, perIp);
    if (purgatoryExternalRates.size > 10_000) {
      for (const [rateKey, entry] of purgatoryExternalRates) {
        if (now - entry.windowStart >= windowMs * 2) purgatoryExternalRates.delete(rateKey);
      }
    }
    return purgatoryGlobalRate.count <= 20 && perIp.count <= 3;
  }

  const pluginUIEventBuffer = new Map<string, Array<{ event: string; payload: any; ts: number }>>();
  const PLUGIN_UI_EVENT_BUFFER_MAX = 200;
  const PLUGIN_UI_EVENT_TTL_MS = 60_000;

  function bufferPluginUIEvent(clientId: string, pluginId: string, event: string, payload: any) {
    const key = `${clientId}:${pluginId}`;
    let list = pluginUIEventBuffer.get(key);
    if (!list) {
      list = [];
      pluginUIEventBuffer.set(key, list);
    }
    list.push({ event, payload, ts: Date.now() });
    if (list.length > PLUGIN_UI_EVENT_BUFFER_MAX) {
      list.splice(0, list.length - PLUGIN_UI_EVENT_BUFFER_MAX);
    }
  }

  function drainPluginUIEvents(clientId: string, pluginId: string): Array<{ event: string; payload: any }> {
    const key = `${clientId}:${pluginId}`;
    const list = pluginUIEventBuffer.get(key);
    if (!list || list.length === 0) return [];
    const now = Date.now();
    const fresh = list.filter((entry) => now - entry.ts < PLUGIN_UI_EVENT_TTL_MS);
    pluginUIEventBuffer.delete(key);
    return fresh.map(({ event, payload }) => ({ event, payload }));
  }

  function requestNotificationScreenshot(info: any, record: NotificationRecord) {
    if (!info || !info.ws) return;
    if (!hasPendingNotificationScreenshotCapacity(
      deps.pendingNotificationScreenshots,
      record.clientId,
    )) {
      logger.warn(`[notify] skipped screenshot request because the pending queue is full client=${record.clientId}`);
      return;
    }
    const commandId = `notify-shot-${uuidv4()}`;
    const timeout = setTimeout(() => {
      deps.pendingNotificationScreenshots.delete(commandId);
    }, 15_000);

    deps.pendingNotificationScreenshots.set(commandId, {
      notificationId: record.id,
      clientId: record.clientId,
      ts: record.ts,
      timeout,
    });

    try {
      info.ws.send(
        encodeMessage({
          type: "command",
          commandType: "screenshot",
          id: commandId,
          payload: { mode: "notification", allDisplays: true },
        } as any),
      );
      metrics.recordCommand("screenshot");
    } catch (err) {
      clearTimeout(timeout);
      deps.pendingNotificationScreenshots.delete(commandId);
      logger.warn("[notify] failed to request screenshot", err);
    }
  }

  function shouldAcceptNotification(key: string, ts: number): boolean {
    const notificationConfig = deps.getNotificationConfig();
    const minInterval = Math.max(1000, notificationConfig.minIntervalMs || 8000);
    const spamWindow = Math.max(5000, notificationConfig.spamWindowMs || 60000);
    const warnThreshold = Math.max(1, notificationConfig.spamWarnThreshold || 5);
    const state = deps.notificationRate.get(key) || {
      lastSent: 0,
      windowStart: ts,
      suppressed: 0,
      lastWarned: 0,
    };

    if (ts - state.windowStart > spamWindow) {
      state.windowStart = ts;
      state.suppressed = 0;
      state.lastWarned = 0;
    }

    if (ts - state.lastSent < minInterval) {
      state.suppressed += 1;
      if (
        state.suppressed >= warnThreshold &&
        ts - state.lastWarned > Math.floor(spamWindow / 2)
      ) {
        logger.warn(`[notify] suppressed ${state.suppressed} notifications in ${spamWindow}ms for ${key}`);
        state.lastWarned = ts;
      }
      deps.notificationRate.set(key, state);
      return false;
    }

    state.lastSent = ts;
    state.suppressed = 0;
    deps.notificationRate.set(key, state);
    return true;
  }

  function checkAntiSpam(key: string, ts: number): boolean {
    const notificationConfig = deps.getNotificationConfig();
    const maxHits = Math.max(1, notificationConfig.antiSpamMaxHits || 15);
    const windowMs = Math.max(5000, notificationConfig.antiSpamWindowMs || 600000);
    const cooldownMs = Math.max(5000, notificationConfig.antiSpamCooldownMs || 600000);

    const state = antiSpamState.get(key);

    if (state) {
      if (ts < state.blockedUntil) {
        return false;
      }

      if (ts - state.windowStart > windowMs) {
        state.windowStart = ts;
        state.hits = 1;
        state.blockedUntil = 0;
        antiSpamState.set(key, state);
        return true;
      }

      state.hits += 1;
      if (state.hits > maxHits) {
        state.blockedUntil = ts + cooldownMs;
        logger.warn(`[notify] anti-spam: blocked keyword for ${key} until ${new Date(state.blockedUntil).toISOString()} (${state.hits} hits in ${windowMs}ms)`);
        antiSpamState.set(key, state);
        return false;
      }

      antiSpamState.set(key, state);
      return true;
    }

    antiSpamState.set(key, { hits: 1, windowStart: ts, blockedUntil: 0 });
    return true;
  }

  function pruneNotificationRate() {
    const notificationConfig = deps.getNotificationConfig();
    const spamWindow = Math.max(5000, notificationConfig.spamWindowMs || 60000);
    const maxAge = spamWindow * 2;
    const now = Date.now();
    for (const [key, state] of deps.notificationRate) {
      if (now - state.lastSent > maxAge && now - state.windowStart > maxAge) {
        deps.notificationRate.delete(key);
      }
    }

    const antiSpamWindowMs = Math.max(5000, notificationConfig.antiSpamWindowMs || 600000);
    const antiSpamCooldownMs = Math.max(5000, notificationConfig.antiSpamCooldownMs || 600000);
    const antiSpamMaxAge = Math.max(antiSpamWindowMs, antiSpamCooldownMs) * 2;
    for (const [key, state] of antiSpamState) {
      if (now - state.windowStart > antiSpamMaxAge && now > state.blockedUntil) {
        antiSpamState.delete(key);
      }
    }

  }

  setInterval(pruneNotificationRate, 60_000).unref?.();

  function flushPluginEvents(clientId: string, pluginId: string) {
    const key = `${clientId}:${pluginId}`;
    const list = deps.pendingPluginEvents.get(key);
    if (!list || list.length === 0) return;
    const target = clientManager.getClient(clientId);
    if (!target) return;
    for (const item of list) {
      target.ws.send(
        encodeMessage({
          type: "plugin_event",
          pluginId,
          event: item.event,
          payload: item.payload,
        } as any),
      );
    }
    deps.pendingPluginEvents.delete(key);
  }

  function markPluginLoaded(clientId: string, pluginId: string) {
    if (!clientId || !pluginId) return;
    let set = deps.pluginLoadedByClient.get(clientId);
    if (!set) {
      set = new Set();
      deps.pluginLoadedByClient.set(clientId, set);
    }
    set.add(pluginId);
    deps.pluginLoadingByClient.get(clientId)?.delete(pluginId);
  }

  return {
    handleNotificationViewerOpen(ws: ServerWebSocket<SocketData>) {
      const sessionId = uuidv4();
      const userId = ws.data.userId;
      const userRole = ws.data.userRole || "";
      sessionManager.addNotificationSession({
        id: sessionId,
        viewer: ws,
        createdAt: Date.now(),
        userId,
        userRole,
      });
      ws.data.sessionId = sessionId;
      logger.info(`[notify] viewer connected session=${sessionId} userId=${userId ?? "?"} role=${userRole}`);

      const allHistory = getNotificationHistory(500);
      const visibleHistory =
        userRole === "admin"
          ? allHistory
          : allHistory.filter(
              (item) =>
                userId !== undefined &&
                deps.canUserAccessClient(userId, userRole, item.clientId),
            );

      safeSendViewer(ws, { type: "ready", sessionId, history: visibleHistory });
    },

    handleNotification(clientId: string, payload: any) {
      const normalized = normalizeClientNotificationPayload(payload);
      if (!normalized) return;
      const ts = Date.now();
      const rateKey = clientId;
      if (!shouldAcceptNotification(rateKey, ts)) {
        return;
      }
      const antiSpamKey = clientId;
      if (!checkAntiSpam(antiSpamKey, ts)) {
        return;
      }
      const info = clientManager.getClient(clientId);
      logger.info(
        `[notify] client=${clientId} keyword=${normalized.keyword || "-"} category=${normalized.category} title=${normalized.title}`,
      );
      const record: NotificationRecord = {
        id: uuidv4(),
        clientId,
        host: info?.host,
        user: info?.user,
        os: info?.os,
        ...normalized,
        ts,
      };

      saveNotification(record);

      const muted = deps.isClientNotificationsMuted(clientId);

      if (muted) {
        return;
      }

      requestNotificationScreenshot(info, record);

      for (const session of sessionManager.getAllNotificationSessions().values()) {
        const sRole = session.userRole ?? session.viewer.data.userRole ?? "";
        const sUserId = session.userId ?? session.viewer.data.userId;
        if (sRole !== "admin") {
          if (sUserId === undefined || !deps.canUserAccessClient(sUserId, sRole, clientId)) {
            continue;
          }
        }
        safeSendViewer(session.viewer, { type: "notification", item: record });
      }

      deps.deliverNotificationWithScreenshot(record).catch((err) =>
        logger.warn("[notify] delivery failed", err),
      );
    },

    handleCrashReport(
      clientId: string,
      crash: { reason: string; detail?: string; host?: string; user?: string; os?: string },
    ) {
      const ts = Date.now();
      if (!shouldAcceptNotification(clientId, ts) || !checkAntiSpam(clientId, ts)) return;

      const reason = sanitizeNotificationText(crash.reason, 128);
      if (!reason) return;

      const info = clientManager.getClient(clientId);
      const detail = sanitizeNotificationText(crash.detail, MAX_NOTIFICATION_PATH_LENGTH);
      const record: NotificationRecord = {
        id: uuidv4(),
        clientId,
        host: crash.host || info?.host,
        user: crash.user || info?.user,
        os: crash.os || info?.os,
        title: `Client crash report: ${reason}`,
        process: "crash report",
        processPath: detail,
        detail,
        keyword: "crash",
        category: "crash_report",
        ts,
      };

      logger.warn(`[notify] crash report client=${clientId} reason=${reason}`);
      saveNotification(record);

      if (deps.isClientNotificationsMuted(clientId)) {
        return;
      }

      for (const session of sessionManager.getAllNotificationSessions().values()) {
        const sRole = session.userRole ?? session.viewer.data.userRole ?? "";
        const sUserId = session.userId ?? session.viewer.data.userId;
        if (sRole !== "admin") {
          if (sUserId === undefined || !deps.canUserAccessClient(sUserId, sRole, clientId)) {
            continue;
          }
        }
        safeSendViewer(session.viewer, { type: "notification", item: record });
      }

      deps.deliverNotificationWithScreenshot(record).catch((err) =>
        logger.warn("[notify] crash report delivery failed", err),
      );
    },

    handleNotificationScreenshotFailure(
      commandId?: string,
      ok?: boolean,
      message?: string,
      clientId?: string,
    ) {
      if (!commandId) return;
      if (ok === true) return;
      const pending = deps.pendingNotificationScreenshots.get(commandId);
      if (!pending) return;
      if (!clientId || pending.clientId !== clientId) {
        logger.warn(
          `[notify] ignored screenshot failure from wrong client commandId=${commandId}`,
        );
        return;
      }
      clearTimeout(pending.timeout);
      deps.pendingNotificationScreenshots.delete(commandId);
      if (message) {
        logger.warn(`[notify] screenshot failed commandId=${commandId} message=${message}`);
      }
    },

    handleNotificationScreenshotResult(clientId: string, payload: any) {
      const commandId = typeof payload.commandId === "string" ? payload.commandId : "";
      if (!commandId) return;
      const pending = deps.pendingNotificationScreenshots.get(commandId);
      if (!pending) return;
      if (pending.clientId !== clientId) {
        logger.warn(
          `[notify] ignored screenshot result for wrong client commandId=${commandId}`,
        );
        return;
      }
      clearTimeout(pending.timeout);
      deps.pendingNotificationScreenshots.delete(commandId);

      if (payload.error) {
        logger.warn(`[notify] screenshot error commandId=${commandId}`, payload.error);
        return;
      }

      const screenshot = validateNotificationScreenshotPayload(payload);
      if (!screenshot) {
        logger.warn(`[notify] rejected invalid screenshot commandId=${commandId}`);
        return;
      }
      deps.storeNotificationScreenshot(
        pending,
        screenshot.bytes,
        screenshot.format,
        screenshot.width,
        screenshot.height,
      );
    },

    clearPendingNotificationScreenshots(clientId: string) {
      for (const [commandId, pending] of deps.pendingNotificationScreenshots.entries()) {
        if (pending.clientId !== clientId) continue;
        clearTimeout(pending.timeout);
        deps.pendingNotificationScreenshots.delete(commandId);
      }
    },

    broadcastNotificationsCleared(clientId: string) {
      for (const key of Array.from(deps.notificationRate.keys())) {
        if (key === clientId || key.startsWith(`${clientId}:`)) {
          deps.notificationRate.delete(key);
        }
      }
      for (const key of Array.from(antiSpamState.keys())) {
        if (key === clientId || key.startsWith(`${clientId}:`)) {
          antiSpamState.delete(key);
        }
      }
      const item = { type: "notifications_cleared", clientId, ts: Date.now() };
      for (const session of sessionManager.getAllNotificationSessions().values()) {
        const sRole = session.userRole ?? session.viewer.data.userRole ?? "";
        const sUserId = session.userId ?? session.viewer.data.userId;
        if (sRole !== "admin") {
          if (sUserId === undefined || !deps.canUserAccessClient(sUserId, sRole, clientId)) {
            continue;
          }
        }
        safeSendViewer(session.viewer, item);
      }
    },

    broadcastClientLifecycleEvent(
      event: "client_online" | "client_offline" | "client_purgatory",
      info: { id: string; host?: string; user?: string; os?: string; ip?: string; country?: string },
    ) {
      if (deps.isClientNotificationsMuted(info.id)) {
        return;
      }
      const item = { type: "client_event", event, clientId: info.id, host: info.host, user: info.user, os: info.os, ip: info.ip, country: info.country, ts: Date.now() };
      for (const session of sessionManager.getAllNotificationSessions().values()) {
        const sRole = session.userRole ?? session.viewer.data.userRole ?? "";
        const sUserId = session.userId ?? session.viewer.data.userId;
        if (event === "client_purgatory") {
          if (sRole === "admin") {
          } else if (sRole === "operator") {
            if (sUserId === undefined || !deps.isClientOwnedByUser(sUserId, info.id)) {
              continue;
            }
          } else {
            continue;
          }
        } else {
          if (sRole !== "admin") {
            if (sUserId === undefined || !deps.canUserAccessClient(sUserId, sRole, info.id)) {
              continue;
            }
          }
        }
        safeSendViewer(session.viewer, item);
      }

      // Keep browser viewers live, but prevent a leaked agent token from
      // amplifying fresh-key enrollment floods into unbounded push/webhook/
      // Telegram traffic.
      if (event === "client_purgatory" && !allowPurgatoryExternalDelivery(info.ip)) {
        logger.warn(`[notify] suppressed excessive purgatory external delivery from ${info.ip || "unknown"}`);
        return;
      }

      const externalTargets = deps.getDeliveryTargetsForClientEvent(event, info.id);
      const pushEnabledByUser = new Map(externalTargets.map((t) => [t.userId, t.clientEventPush]));

      deliverWebPushClientEvent(
        event,
        info,
        deps.canUserAccessClient,
        deps.getUserRole,
        (userId) => {
          const enabled = pushEnabledByUser.get(userId);
          return enabled !== undefined ? enabled : true;
        },
        deps.isClientOwnedByUser,
      ).catch((err) => logger.warn("[notify] web push client event delivery failed", err));

      deliverClientEventToExternalChannels(event, info, externalTargets).catch((err) =>
        logger.warn("[notify] external channel client event delivery failed", err),
      );
    },

    markPluginLoaded,

    clearClientPluginState(clientId: string) {
      deps.pluginLoadedByClient.delete(clientId);
      deps.pluginLoadingByClient.delete(clientId);
    },

    isPluginLoaded(clientId: string, pluginId: string): boolean {
      return deps.pluginLoadedByClient.get(clientId)?.has(pluginId) ?? false;
    },

    isPluginLoading(clientId: string, pluginId: string): boolean {
      return deps.pluginLoadingByClient.get(clientId)?.has(pluginId) ?? false;
    },

    markPluginLoading(clientId: string, pluginId: string) {
      if (!clientId || !pluginId) return;
      let set = deps.pluginLoadingByClient.get(clientId);
      if (!set) {
        set = new Set();
        deps.pluginLoadingByClient.set(clientId, set);
      }
      set.add(pluginId);
    },

    enqueuePluginEvent(clientId: string, pluginId: string, event: string, payload: any) {
      const key = `${clientId}:${pluginId}`;
      const list = deps.pendingPluginEvents.get(key) || [];
      list.push({ event, payload });
      deps.pendingPluginEvents.set(key, list);
    },

    handlePluginEvent(clientId: string, payload: any) {
      const pluginId = (payload as any).pluginId || "";
      const event = (payload as any).event || "";
      const error = (payload as any).error || "";
      const eventPayload = (payload as any).payload;
      logger.debug(`[plugin] client=${clientId} plugin=${pluginId} event=${event} error=${error}`);
      if (event === "loaded") {
        markPluginLoaded(clientId, pluginId);
        flushPluginEvents(clientId, pluginId);
        if (pluginId) {
          deps.pluginState.lastError[pluginId] = "";
          void deps.savePluginState();
        }
      }
      if (event === "unloaded") {
        deps.pluginLoadedByClient.get(clientId)?.delete(pluginId);
      }
      if (event === "error" || error) {
        if (pluginId) {
          deps.pluginState.lastError[pluginId] = error || String((payload as any).message || "plugin error");
          void deps.savePluginState();
        }
      }
      // Buffer all events for UI polling
      if (pluginId && event) {
        bufferPluginUIEvent(clientId, pluginId, event, eventPayload ?? (error ? { error } : null));
      }
      if (pluginId && event && deps.forwardPluginEventToRuntime) {
        try {
          deps.forwardPluginEventToRuntime(
            clientId,
            pluginId,
            event,
            eventPayload ?? (error ? { error } : null),
          );
        } catch (err) {
          logger.warn(`[plugin] runtime dispatch failed: ${(err as Error).message}`);
        }
      }
    },

    drainPluginUIEvents,
  };
}
