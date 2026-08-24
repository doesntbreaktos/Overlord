import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export const DEFAULT_FETCH_URL_MAX_BYTES = 250 * 1024 * 1024;

type LookupAddress = { address: string };
type LookupFn = (hostname: string) => Promise<LookupAddress[]>;

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function ipv4ToBytes(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => Number(p));
  if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null;
  return bytes;
}

function isPrivateIPv4(address: string): boolean {
  const b = ipv4ToBytes(address);
  if (!b) return true;
  const [a, second, third] = b;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && second >= 64 && second <= 127) ||
    (a === 169 && second === 254) ||
    (a === 172 && second >= 16 && second <= 31) ||
    (a === 192 && second === 168) ||
    (a === 192 && second === 0 && (third === 0 || third === 2)) ||
    (a === 192 && second === 88 && third === 99) ||
    (a === 198 && (second === 18 || second === 19)) ||
    (a === 198 && second === 51 && third === 100) ||
    (a === 203 && second === 0 && third === 113) ||
    a >= 224
  );
}

function ipv6ToBytes(address: string): number[] | null {
  let host = normalizeHost(address).split("%")[0];
  if (!host) return null;

  const dottedMatch = host.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedMatch) {
    const ipv4 = ipv4ToBytes(dottedMatch[2]);
    if (!ipv4) return null;
    host = `${dottedMatch[1]}${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }

  const halves = host.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] | null => {
    if (!half) return [];
    const values = half.split(":").map((part) => Number.parseInt(part, 16));
    if (
      values.some((value, index) =>
        !/^[0-9a-f]{1,4}$/i.test(half.split(":")[index] || "") ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > 0xffff
      )
    ) {
      return null;
    }
    return values;
  };

  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = halves.length === 2
    ? [...left, ...new Array(missing).fill(0), ...right]
    : left;
  if (words.length !== 8) return null;

  const bytes: number[] = [];
  for (const word of words) bytes.push(word >> 8, word & 0xff);
  return bytes;
}

function isPrivateIPv6(address: string): boolean {
  const bytes = ipv6ToBytes(address);
  if (!bytes) return true;

  // Unspecified, loopback, and deprecated IPv4-compatible space.
  if (bytes.slice(0, 12).every((byte) => byte === 0)) return true;

  // IPv4-mapped IPv6 addresses inherit the embedded IPv4 classification.
  if (
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  ) {
    return isPrivateIPv4(bytes.slice(12).join("."));
  }

  const first = (bytes[0] << 8) | bytes[1];
  if ((first & 0xfe00) === 0xfc00) return true; // Unique-local fc00::/7.
  if ((first & 0xffc0) === 0xfe80) return true; // Link-local fe80::/10.
  if ((first & 0xffc0) === 0xfec0) return true; // Deprecated site-local fec0::/10.
  if (bytes[0] === 0xff) return true; // Multicast ff00::/8.

  // Special translation/tunneling/documentation ranges should never be
  // treated as ordinary public destinations for server-side fetches.
  if (first === 0x0064 && bytes[2] === 0xff && bytes[3] === 0x9b) return true;
  if (first === 0x0100 && bytes.slice(2, 8).every((byte) => byte === 0)) return true;
  if (first === 0x2001 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  if (first === 0x2001 && bytes[2] === 0 && bytes[3] === 0) return true;
  if (first === 0x2002) return true;

  return false;
}

export function isPrivateOrLocalAddress(address: string): boolean {
  const host = normalizeHost(address);
  const family = isIP(host);
  if (family === 4) return isPrivateIPv4(host);
  if (family === 6) return isPrivateIPv6(host);
  return false;
}

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
  return await dnsLookup(hostname, { all: true, verbatim: true });
}

async function resolvePublicHttpUrl(
  rawUrl: string,
  lookupFn: LookupFn = defaultLookup,
): Promise<{ parsed: URL; addresses: LookupAddress[] }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed");
  }
  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }

  const hostname = normalizeHost(parsed.hostname);
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".internal")) {
    throw new Error("URLs pointing to private/internal addresses are not allowed");
  }

  const literalFamily = isIP(hostname);
  const addresses = literalFamily ? [{ address: hostname }] : await lookupWithDeadline(hostname, lookupFn);
  if (addresses.length === 0 || addresses.some((entry) => isPrivateOrLocalAddress(entry.address))) {
    throw new Error("URLs pointing to private/internal addresses are not allowed");
  }

  return { parsed, addresses };
}

export async function validatePublicHttpUrl(
  rawUrl: string,
  lookupFn: LookupFn = defaultLookup,
): Promise<URL> {
  return (await resolvePublicHttpUrl(rawUrl, lookupFn)).parsed;
}

export type PublicHttpRequestOptions = {
  maxResponseBytes?: number;
  timeoutMs?: number;
  lookupFn?: LookupFn;
};

export function createSafeUpstreamResponse(
  body: Uint8Array<ArrayBuffer>,
  statusCode: number | undefined,
  statusMessage: string | undefined,
  rawHeaders: string[],
): Response {
  const responseHeaders = new Headers();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    responseHeaders.append(rawHeaders[i], rawHeaders[i + 1] ?? "");
  }
  const rawStatus = Number(statusCode);
  const status = Number.isInteger(rawStatus) && rawStatus >= 200 && rawStatus <= 599
    ? rawStatus
    : 502;
  const responseBody = status === 204 || status === 205 || status === 304 ? null : body;
  return new Response(responseBody, {
    status,
    statusText: status === rawStatus ? statusMessage : undefined,
    headers: responseHeaders,
  });
}

const DEFAULT_PUBLIC_HTTP_RESPONSE_MAX_BYTES = 64 * 1024;
const DEFAULT_PUBLIC_HTTP_TIMEOUT_MS = 15_000;
const PUBLIC_DNS_LOOKUP_TIMEOUT_MS = 5_000;

async function lookupWithDeadline(
  hostname: string,
  lookupFn: LookupFn,
): Promise<LookupAddress[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookupFn(hostname),
      new Promise<LookupAddress[]>((_, reject) => {
        timer = setTimeout(() => reject(new Error("DNS lookup timed out")), PUBLIC_DNS_LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fetch an untrusted public URL while pinning the socket to the address that was
 * checked. This closes the DNS-rebinding gap between validation and connect.
 * Redirects are deliberately returned to the caller rather than followed.
 */
export async function fetchPublicHttpResponse(
  rawUrl: string,
  init: RequestInit = {},
  options: PublicHttpRequestOptions = {},
): Promise<Response> {
  const { parsed, addresses } = await resolvePublicHttpUrl(
    rawUrl,
    options.lookupFn ?? defaultLookup,
  );
  const pinned = addresses[0];
  const family = isIP(normalizeHost(pinned.address));
  if (family !== 4 && family !== 6) {
    throw new Error("Resolved URL address is invalid");
  }

  const prepared = new Request(parsed, init);
  const requestBody = prepared.body
    ? new Uint8Array(await prepared.arrayBuffer())
    : null;
  const headers = new Headers(prepared.headers);
  if (requestBody && !headers.has("content-length")) {
    headers.set("content-length", String(requestBody.byteLength));
  }

  const maxResponseBytes = Math.max(
    0,
    Math.floor(options.maxResponseBytes ?? DEFAULT_PUBLIC_HTTP_RESPONSE_MAX_BYTES),
  );
  const timeoutMs = Math.max(
    1,
    Math.floor(options.timeoutMs ?? DEFAULT_PUBLIC_HTTP_TIMEOUT_MS),
  );
  const requestImpl = parsed.protocol === "https:" ? httpsRequest : httpRequest;

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    let absoluteTimer: ReturnType<typeof setTimeout> | undefined;
    const clearAbsoluteTimer = () => {
      if (absoluteTimer) {
        clearTimeout(absoluteTimer);
        absoluteTimer = undefined;
      }
    };
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearAbsoluteTimer();
      reject(error);
    };

    const request = requestImpl(
      parsed,
      {
        method: prepared.method,
        headers: Object.fromEntries(headers.entries()),
        lookup: ((
          _hostname: string,
          optionsOrCallback: any,
          maybeCallback?: any,
        ) => {
          const callback = typeof optionsOrCallback === "function"
            ? optionsOrCallback
            : maybeCallback;
          if (typeof callback !== "function") return;
          if (optionsOrCallback?.all) {
            callback(null, [{ address: pinned.address, family }]);
          } else {
            callback(null, pinned.address, family);
          }
        }) as any,
      },
      (response) => {
        const chunks: Uint8Array[] = [];
        let total = 0;

        response.on("data", (chunk: Uint8Array) => {
          if (settled) return;
          const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          total += bytes.byteLength;
          if (total > maxResponseBytes) {
            response.destroy();
            request.destroy();
            finishReject(new Error(`Remote response exceeds ${maxResponseBytes} byte limit`));
            return;
          }
          chunks.push(bytes);
        });
        response.on("error", (error) => finishReject(error));
        response.on("end", () => {
          if (settled) return;
          try {
            const body = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
              body.set(chunk, offset);
              offset += chunk.byteLength;
            }
            const safeResponse = createSafeUpstreamResponse(
              body,
              response.statusCode,
              response.statusMessage,
              response.rawHeaders,
            );
            settled = true;
            clearAbsoluteTimer();
            resolve(safeResponse);
          } catch (error) {
            finishReject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy();
      finishReject(new Error("Remote request timed out"));
    });
    absoluteTimer = setTimeout(() => {
      request.destroy();
      finishReject(new Error("Remote request exceeded its absolute time limit"));
    }, timeoutMs);
    request.on("error", (error) => finishReject(error));

    if (prepared.signal.aborted) {
      request.destroy();
      finishReject(new Error("Remote request aborted"));
      return;
    }
    prepared.signal.addEventListener(
      "abort",
      () => {
        request.destroy();
        finishReject(new Error("Remote request aborted"));
      },
      { once: true },
    );

    if (requestBody) request.write(requestBody);
    request.end();
  });
}

export function getFetchUrlMaxBytes(): number {
  const parsed = Number(process.env.OVERLORD_DEPLOY_FETCH_MAX_BYTES);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return DEFAULT_FETCH_URL_MAX_BYTES;
}

export async function fetchPublicUrlBytes(
  rawUrl: string,
  maxBytes = getFetchUrlMaxBytes(),
  lookupFn: LookupFn = defaultLookup,
): Promise<{ bytes: Uint8Array; finalUrl: URL }> {
  let current = await validatePublicHttpUrl(rawUrl, lookupFn);

  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetchPublicHttpResponse(
      current.toString(),
      { method: "GET" },
      { maxResponseBytes: maxBytes, timeoutMs: 60_000, lookupFn },
    );

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Remote fetch failed: ${response.status}`);
      if (redirects === 3) throw new Error("Too many redirects");
      current = await validatePublicHttpUrl(new URL(location, current).toString(), lookupFn);
      continue;
    }

    if (!response.ok) {
      throw new Error(`Remote fetch failed: ${response.status}`);
    }

    return { bytes: new Uint8Array(await response.arrayBuffer()), finalUrl: current };
  }

  throw new Error("Too many redirects");
}
