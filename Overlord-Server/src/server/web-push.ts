import webpush from "web-push";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { ensureDataDir } from "../paths";
import { logger } from "../logger";
import { fetchPublicHttpResponse, validatePublicHttpUrl } from "./url-security";

let vapidKeys: { publicKey: string; privateKey: string } | null = null;

function getVapidPath(): string {
  return resolve(ensureDataDir(), "vapid-keys.json");
}

export function loadOrGenerateVapidKeys(): { publicKey: string; privateKey: string } {
  if (vapidKeys) return vapidKeys;

  const vapidPath = getVapidPath();

  if (existsSync(vapidPath)) {
    try {
      const raw = readFileSync(vapidPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.publicKey && parsed.privateKey) {
        vapidKeys = { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
        logger.info("[web-push] loaded VAPID keys from " + vapidPath);
        return vapidKeys;
      }
    } catch (err) {
      logger.warn("[web-push] failed to read vapid-keys.json, regenerating", err);
    }
  }

  const generated = webpush.generateVAPIDKeys();
  vapidKeys = { publicKey: generated.publicKey, privateKey: generated.privateKey };

  try {
    writeFileSync(vapidPath, JSON.stringify(vapidKeys, null, 2));
    logger.info("[web-push] generated and saved VAPID keys to " + vapidPath);
  } catch (err) {
    logger.warn("[web-push] failed to persist VAPID keys", err);
  }

  return vapidKeys;
}

export function getVapidPublicKey(): string {
  return loadOrGenerateVapidKeys().publicKey;
}

type GeneratedWebPushRequest = {
  endpoint: string;
  method: string;
  headers: Record<string, string | number>;
  body: Buffer | null;
};

type PublicHttpRequest = typeof fetchPublicHttpResponse;

type WebPushResult = { success: boolean; gone?: boolean; error?: string };

function requireHttpsPushEndpoint(rawEndpoint: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new Error("Invalid URL");
  }
  if (endpoint.protocol !== "https:") {
    throw new Error("push endpoint must use HTTPS");
  }
  if (endpoint.username || endpoint.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }
  return endpoint;
}

/**
 * Send request details produced by web-push through the server's SSRF-safe
 * transport. The transport validates and pins the resolved public address to
 * the actual HTTPS socket, so a push endpoint cannot rebind between a DNS
 * safety check and the connection.
 */
export async function dispatchGeneratedWebPushRequest(
  details: GeneratedWebPushRequest,
  request: PublicHttpRequest = fetchPublicHttpResponse,
): Promise<Response> {
  requireHttpsPushEndpoint(details.endpoint);

  const headers = new Headers();
  for (const [name, value] of Object.entries(details.headers)) {
    headers.set(name, String(value));
  }

  return await request(details.endpoint, {
    method: details.method,
    headers,
    body: details.body === null ? undefined : new Uint8Array(details.body),
  });
}

export function webPushResultForStatus(statusCode: number): WebPushResult {
  if (statusCode >= 200 && statusCode <= 299) {
    return { success: true };
  }
  if (statusCode === 404 || statusCode === 410) {
    return { success: false, gone: true, error: `subscription gone (${statusCode})` };
  }
  return { success: false, error: "Received unexpected response code" };
}

export async function sendWebPush(
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
): Promise<WebPushResult> {
  try {
    requireHttpsPushEndpoint(subscription.endpoint);
    await validatePublicHttpUrl(subscription.endpoint);
  } catch (err: any) {
    return { success: false, error: err?.message || "invalid push endpoint" };
  }

  const keys = loadOrGenerateVapidKeys();
  webpush.setVapidDetails("mailto:overlord@localhost", keys.publicKey, keys.privateKey);

  try {
    const details = webpush.generateRequestDetails(subscription, payload, { TTL: 60 * 60 });
    const response = await dispatchGeneratedWebPushRequest(details);
    return webPushResultForStatus(response.status);
  } catch (err: any) {
    const statusCode = err?.statusCode;
    if (statusCode === 404 || statusCode === 410) {
      return { success: false, gone: true, error: `subscription gone (${statusCode})` };
    }
    return { success: false, error: err?.message || String(err) };
  }
}
