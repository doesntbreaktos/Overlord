import { isIP } from "node:net";

function envFlagEnabled(name: string): boolean {
  const v = String(process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

let trustProxyCache: boolean | null = null;

export function isTrustProxyEnabled(): boolean {
  if (trustProxyCache !== null) return trustProxyCache;
  trustProxyCache =
    envFlagEnabled("OVERLORD_TRUST_PROXY") || envFlagEnabled("OVERLORD_TLS_OFFLOAD");
  return trustProxyCache;
}

export function resetTrustProxyCacheForTests(): void {
  trustProxyCache = null;
}

function isIPv4(ip: string): boolean {
  return isIP(ip) === 4;
}

function isIPv6(ip: string): boolean {
  return isIP(ip) === 6;
}

function stripIPv6Brackets(ip: string): string {
  if (ip.startsWith("[") && ip.endsWith("]")) return ip.slice(1, -1);
  return ip;
}

function stripPort(ip: string): string {
  if (ip.startsWith("[")) {
    const close = ip.indexOf("]");
    if (close !== -1) return ip.slice(1, close);
  }
  if (isIPv4(ip)) return ip;
  const colons = (ip.match(/:/g) || []).length;
  if (colons === 1) return ip.split(":")[0];
  return ip;
}

function normalizeCandidate(raw: string): string {
  return stripIPv6Brackets(stripPort(raw.trim()));
}

function isValidIp(ip: string): boolean {
  return isIPv4(ip) || isIPv6(ip);
}

export function isLoopbackIp(ip: string): boolean {
  if (isIPv4(ip)) return Number(ip.split(".")[0]) === 127;
  if (!isIPv6(ip)) return false;
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  const dottedMapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedMapped) return Number(dottedMapped[1].split(".")[0]) === 127;
  const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  return !!hexMapped && (Number.parseInt(hexMapped[1], 16) >> 8) === 127;
}

function isTrustedImmediateProxy(peer: string): boolean {
  const normalized = normalizeCandidate(peer);
  if (!isValidIp(normalized)) return false;
  if (isLoopbackIp(normalized)) return true;
  const configured = String(process.env.OVERLORD_TRUSTED_PROXY_IPS || "")
    .split(",")
    .map(normalizeCandidate)
    .filter(Boolean);
  return configured.includes(normalized);
}

export function resolveForwardedIp(req: Request, fallback: string): string {
  if (!isTrustProxyEnabled()) return fallback;
  if (!isTrustedImmediateProxy(fallback)) return fallback;

  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((s) => normalizeCandidate(s))
      .filter(isValidIp);
    // A conforming edge proxy appends the actual peer address. Selecting from
    // the right prevents an attacker from choosing a spoofed leftmost value.
    if (parts.length > 0) return parts[parts.length - 1];
  }

  const xri = req.headers.get("x-real-ip");
  if (xri) {
    const normalized = normalizeCandidate(xri);
    if (isValidIp(normalized)) return normalized;
  }

  const cfConnecting = req.headers.get("cf-connecting-ip");
  if (cfConnecting) {
    const normalized = normalizeCandidate(cfConnecting);
    if (isValidIp(normalized)) return normalized;
  }

  return fallback;
}

export type RequestServerLike = {
  requestIP: (req: Request) => { address?: string } | null | undefined;
  upgrade: (req: Request, data: any) => boolean;
};

export function wrapServerWithClientIp<T extends RequestServerLike>(server: T): T {
  const wrapped = {
    requestIP: (req: Request) => {
      const peer = server.requestIP(req)?.address || "";
      const real = resolveForwardedIp(req, peer);
      return { address: real };
    },
    upgrade: (req: Request, data: any) => server.upgrade(req, data),
  };
  return new Proxy(server as object, {
    get(target, prop, receiver) {
      if (prop === "requestIP") return wrapped.requestIP;
      if (prop === "upgrade") return wrapped.upgrade;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}
