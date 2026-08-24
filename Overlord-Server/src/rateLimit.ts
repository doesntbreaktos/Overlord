import { logger } from "./logger";
import { getConfig } from "./config";

interface RateLimitEntry {
  attempts: number;
  firstAttempt: number;
  lockedUntil?: number;
}

type RequestRateLimitPolicy = {
  maxRequests: number;
  windowMs: number;
  lockoutMs: number;
};

const rateLimitStore = new Map<string, RateLimitEntry>();
const requestRateLimitStore = new Map<string, RateLimitEntry>();

const CLEANUP_INTERVAL = 60 * 1000;

function numberFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getRateLimitPolicy() {
  const security = getConfig().security;
  const maxAttempts = Math.min(50, Math.max(1, Number(security.loginMaxAttempts) || 5));
  const windowMs = Math.min(24 * 60 * 60 * 1000, Math.max(60 * 1000, (Number(security.loginWindowMinutes) || 15) * 60 * 1000));
  const lockoutMs = Math.min(24 * 60 * 60 * 1000, Math.max(60 * 1000, (Number(security.loginLockoutMinutes) || 30) * 60 * 1000));
  return { maxAttempts, windowMs, lockoutMs };
}

export function isRateLimited(ip: string): {
  limited: boolean;
  retryAfter?: number;
} {
  const policy = getRateLimitPolicy();
  const entry = rateLimitStore.get(ip);

  if (!entry) {
    return { limited: false };
  }

  const now = Date.now();

  if (entry.lockedUntil && entry.lockedUntil > now) {
    const retryAfter = Math.ceil((entry.lockedUntil - now) / 1000);
    return { limited: true, retryAfter };
  }

  if (now - entry.firstAttempt > policy.windowMs) {
    rateLimitStore.delete(ip);
    return { limited: false };
  }

  if (entry.attempts >= policy.maxAttempts) {
    entry.lockedUntil = now + policy.lockoutMs;
    const retryAfter = Math.ceil(policy.lockoutMs / 1000);
    logger.warn(
      `[rate-limit] IP ${ip} locked out for ${retryAfter}s after ${entry.attempts} failed attempts`,
    );
    return { limited: true, retryAfter };
  }

  return { limited: false };
}

export function recordFailedAttempt(ip: string): void {
  const policy = getRateLimitPolicy();
  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  if (!entry) {
    rateLimitStore.set(ip, {
      attempts: 1,
      firstAttempt: now,
    });
    return;
  }

  if (now - entry.firstAttempt > policy.windowMs) {
    rateLimitStore.set(ip, {
      attempts: 1,
      firstAttempt: now,
    });
    return;
  }

  entry.attempts++;
  logger.debug(
    `[rate-limit] IP ${ip} failed attempt ${entry.attempts}/${policy.maxAttempts}`,
  );
}

export function recordSuccessfulAttempt(ip: string): void {
  rateLimitStore.delete(ip);
}

function makeRequestPolicy(prefix: string, defaults: RequestRateLimitPolicy): RequestRateLimitPolicy {
  return {
    maxRequests: Math.min(
      1000,
      Math.max(1, numberFromEnv(`OVERLORD_${prefix}_RATE_LIMIT_MAX`, defaults.maxRequests)),
    ),
    windowMs: Math.min(
      60 * 60 * 1000,
      Math.max(10 * 1000, numberFromEnv(`OVERLORD_${prefix}_RATE_LIMIT_WINDOW_SECONDS`, defaults.windowMs / 1000) * 1000),
    ),
    lockoutMs: Math.min(
      60 * 60 * 1000,
      Math.max(10 * 1000, numberFromEnv(`OVERLORD_${prefix}_RATE_LIMIT_LOCKOUT_SECONDS`, defaults.lockoutMs / 1000) * 1000),
    ),
  };
}

function consumeRequestRateLimit(
  key: string,
  label: string,
  policy: RequestRateLimitPolicy,
): { limited: boolean; retryAfter?: number } {
  const now = Date.now();
  const entry = requestRateLimitStore.get(key);

  if (entry?.lockedUntil && entry.lockedUntil > now) {
    return { limited: true, retryAfter: Math.ceil((entry.lockedUntil - now) / 1000) };
  }

  if (!entry || now - entry.firstAttempt > policy.windowMs) {
    requestRateLimitStore.set(key, { attempts: 1, firstAttempt: now });
    return { limited: false };
  }

  entry.attempts++;
  if (entry.attempts > policy.maxRequests) {
    entry.lockedUntil = now + policy.lockoutMs;
    const retryAfter = Math.ceil(policy.lockoutMs / 1000);
    logger.warn(
      `[rate-limit] ${label} rate limit exceeded for ${key}; locked for ${retryAfter}s after ${entry.attempts} requests`,
    );
    return { limited: true, retryAfter };
  }

  return { limited: false };
}

export function consumeLoginPageRateLimit(ip: string): { limited: boolean; retryAfter?: number } {
  const policy = makeRequestPolicy("LOGIN_PAGE", {
    maxRequests: 60,
    windowMs: 5 * 60 * 1000,
    lockoutMs: 10 * 60 * 1000,
  });
  return consumeRequestRateLimit(`login-page:${ip}`, "Login page", policy);
}

export function consumeUnauthorizedRateLimit(ip: string): { limited: boolean; retryAfter?: number } {
  const policy = makeRequestPolicy("UNAUTHORIZED", {
    maxRequests: 120,
    windowMs: 5 * 60 * 1000,
    lockoutMs: 10 * 60 * 1000,
  });
  return consumeRequestRateLimit(`unauthorized:${ip}`, "Unauthorized request", policy);
}

export function consumeSolRpcRateLimit(
  userId: number,
  action: "balance" | "publish",
): { limited: boolean; retryAfter?: number } {
  const policy = action === "publish"
    ? makeRequestPolicy("SOL_PUBLISH", { maxRequests: 3, windowMs: 5 * 60 * 1000, lockoutMs: 5 * 60 * 1000 })
    : makeRequestPolicy("SOL_BALANCE", { maxRequests: 12, windowMs: 60 * 1000, lockoutMs: 60 * 1000 });
  return consumeRequestRateLimit(`sol-${action}:${userId}`, `Solana ${action}`, policy);
}

export function consumePushSubscriptionMutationRateLimit(
  userId: number,
): { limited: boolean; retryAfter?: number } {
  const policy = makeRequestPolicy("PUSH_SUBSCRIPTION", {
    maxRequests: 20,
    windowMs: 60 * 1000,
    lockoutMs: 60 * 1000,
  });
  return consumeRequestRateLimit(
    `push-subscription:${userId}`,
    "Push subscription mutation",
    policy,
  );
}

export function clearRequestRateLimitsForTests(): void {
  requestRateLimitStore.clear();
}

function cleanupExpired(): void {
  const policy = getRateLimitPolicy();
  const now = Date.now();
  let cleaned = 0;

  for (const [ip, entry] of rateLimitStore.entries()) {
    const windowExpired = now - entry.firstAttempt > policy.windowMs;
    const lockoutExpired = entry.lockedUntil && entry.lockedUntil < now;

    if ((windowExpired && !entry.lockedUntil) || lockoutExpired) {
      rateLimitStore.delete(ip);
      cleaned++;
    }
  }

  for (const [key, entry] of requestRateLimitStore.entries()) {
    const expired = now - entry.firstAttempt > 60 * 60 * 1000;
    const lockoutExpired = entry.lockedUntil && entry.lockedUntil < now;
    if (expired || lockoutExpired) {
      requestRateLimitStore.delete(key);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.debug(`[rate-limit] Cleaned up ${cleaned} expired entries`);
  }
}

export function getRateLimitStats(): { total: number; locked: number } {
  const now = Date.now();
  let locked = 0;

  for (const entry of rateLimitStore.values()) {
    if (entry.lockedUntil && entry.lockedUntil > now) {
      locked++;
    }
  }

  return {
    total: rateLimitStore.size,
    locked,
  };
}

setInterval(cleanupExpired, CLEANUP_INTERVAL);

const initialPolicy = getRateLimitPolicy();
logger.info(
  `[rate-limit] Initialized: ${initialPolicy.maxAttempts} attempts per ${Math.round(initialPolicy.windowMs / 60000)} minutes, ${Math.round(initialPolicy.lockoutMs / 60000)} minute lockout`,
);
