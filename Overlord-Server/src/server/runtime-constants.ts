function positiveIntEnv(name: string, fallback: number): number {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export const HEARTBEAT_INTERVAL_MS = positiveIntEnv("OVERLORD_HEARTBEAT_INTERVAL_MS", 15_000);
export const STALE_MS = positiveIntEnv("OVERLORD_STALE_MS", 90_000);
export const DISCONNECT_TIMEOUT_MS = positiveIntEnv("OVERLORD_DISCONNECT_TIMEOUT_MS", 10_000);

export const PRUNE_BATCH = Number(process.env.PRUNE_BATCH || 500);
export const MAX_WS_MESSAGE_BYTES_VIEWER = positiveIntEnv("MAX_WS_MESSAGE_BYTES_VIEWER", 64_000_000);
export const MAX_WS_MESSAGE_BYTES_CLIENT = positiveIntEnv("MAX_WS_MESSAGE_BYTES_CLIENT", 256_000_000);
