function boundedIntegerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

const THUMBNAIL_WIDTH = boundedIntegerEnv("OVERLORD_THUMBNAIL_WIDTH", 1920, 64, 8192);
const THUMBNAIL_HEIGHT = boundedIntegerEnv("OVERLORD_THUMBNAIL_HEIGHT", 1080, 48, 8192);
const THUMBNAIL_QUALITY = boundedIntegerEnv("OVERLORD_THUMBNAIL_QUALITY", 88, 40, 95);
export const MAX_THUMBNAIL_SOURCE_BYTES = boundedIntegerEnv(
  "OVERLORD_THUMBNAIL_MAX_SOURCE_BYTES",
  64 * 1024 * 1024,
  256 * 1024,
  64 * 1024 * 1024,
);
const THUMBNAIL_CACHE_MAX = boundedIntegerEnv(
  "OVERLORD_THUMBNAIL_CACHE_MAX",
  2000,
  64,
  10_000,
);
const THUMBNAIL_CACHE_MAX_BYTES = boundedIntegerEnv(
  "OVERLORD_THUMBNAIL_CACHE_MAX_BYTES",
  1024 * 1024 * 1024,
  16 * 1024 * 1024,
  4 * 1024 * 1024 * 1024,
);
const MAX_CONCURRENT_THUMBNAIL_GEN = boundedIntegerEnv(
  "OVERLORD_THUMBNAIL_CONCURRENCY",
  4,
  1,
  32,
);
export const MAX_PENDING_THUMBNAIL_FRAMES = boundedIntegerEnv(
  "OVERLORD_THUMBNAIL_PENDING_MAX_COUNT",
  512,
  1,
  4096,
);
export const MAX_PENDING_THUMBNAIL_BYTES = boundedIntegerEnv(
  "OVERLORD_THUMBNAIL_PENDING_MAX_BYTES",
  512 * 1024 * 1024,
  1024 * 1024,
  1024 * 1024 * 1024,
);
export const MAX_QUEUED_THUMBNAIL_GEN = boundedIntegerEnv(
  "OVERLORD_THUMBNAIL_QUEUE_MAX",
  512,
  0,
  4096,
);
export const MAX_THUMBNAIL_REQUEST_IDS = boundedIntegerEnv(
  "OVERLORD_THUMBNAIL_REQUEST_MAX",
  4096,
  16,
  4096,
);
export const MAX_THUMBNAIL_WAITER_IDS = boundedIntegerEnv(
  "OVERLORD_THUMBNAIL_WAITER_ID_MAX",
  4096,
  16,
  4096,
);
export const MAX_THUMBNAIL_WAITERS = boundedIntegerEnv(
  "OVERLORD_THUMBNAIL_WAITER_MAX",
  8192,
  16,
  8192,
);
const MAX_THUMBNAIL_WAITERS_PER_ID = 16;
const THUMBNAIL_REQUEST_RETENTION_MS = 30_000;
const MAX_THUMBNAIL_WAITER_TIMEOUT_MS = 10_000;

export type ThumbnailScheduleResult<T> =
  | { accepted: true; value: T }
  | { accepted: false };

export function createBoundedThumbnailScheduler(maxConcurrent: number, maxQueued: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return {
    run<T>(fn: () => Promise<T>): Promise<ThumbnailScheduleResult<T>> {
      return new Promise<ThumbnailScheduleResult<T>>((resolve, reject) => {
        const execute = () => {
          active += 1;
          fn().then(
            (value) => resolve({ accepted: true, value }),
            reject,
          ).finally(() => {
            active -= 1;
            const next = queue.shift();
            if (next) next();
          });
        };
        if (active < maxConcurrent) {
          execute();
        } else if (queue.length < maxQueued) {
          queue.push(execute);
        } else {
          resolve({ accepted: false });
        }
      });
    },
    getStats(): { active: number; queued: number } {
      return { active, queued: queue.length };
    },
  };
}

const thumbnailScheduler = createBoundedThumbnailScheduler(
  MAX_CONCURRENT_THUMBNAIL_GEN,
  MAX_QUEUED_THUMBNAIL_GEN,
);

type ThumbnailRecord = {
  bytes: Uint8Array;
  contentType: string;
  version: number;
  updatedAt: number;
};

const thumbnails = new Map<string, ThumbnailRecord>();
const latestFrames = new Map<string, { bytes: Uint8Array; format: string; capturedAt: number }>();
const thumbnailRequests = new Map<string, number>();
let cachedThumbnailBytes = 0;
let latestFrameBytes = 0;
let thumbnailVersionSequence = Date.now();

type BunImageConstructor = new (
  bytes: Uint8Array,
  options?: { autoOrient?: boolean; maxPixels?: number },
) => {
  resize(
    width: number,
    height: number,
    options?: { fit?: "inside"; withoutEnlargement?: boolean },
  ): {
    webp(options?: { quality?: number }): {
      bytes(): Promise<ArrayBuffer | Uint8Array>;
    };
  };
};

function getBunImage(): BunImageConstructor | null {
  const imageCtor = (Bun as unknown as { Image?: BunImageConstructor }).Image;
  return typeof imageCtor === "function" ? imageCtor : null;
}

function touchThumbnailLRU(id: string) {
  const existing = thumbnails.get(id);
  if (!existing) return;
  thumbnails.delete(id);
  thumbnails.set(id, existing);
}

function deleteCachedThumbnail(id: string): boolean {
  const existing = thumbnails.get(id);
  if (!existing) return false;
  thumbnails.delete(id);
  cachedThumbnailBytes = Math.max(0, cachedThumbnailBytes - existing.bytes.byteLength);
  return true;
}

function evictThumbnailsIfFull() {
  while (
    thumbnails.size > THUMBNAIL_CACHE_MAX
    || cachedThumbnailBytes > THUMBNAIL_CACHE_MAX_BYTES
  ) {
    const oldestKey = thumbnails.keys().next().value;
    if (oldestKey === undefined) break;
    deleteCachedThumbnail(oldestKey);
  }
}

function deleteLatestFrame(
  id: string,
  expected?: { bytes: Uint8Array; format: string; capturedAt: number },
): boolean {
  const existing = latestFrames.get(id);
  if (!existing || (expected && existing !== expected)) return false;
  latestFrames.delete(id);
  latestFrameBytes = Math.max(0, latestFrameBytes - existing.bytes.byteLength);
  return true;
}

function nextThumbnailVersion(prior?: ThumbnailRecord): number {
  thumbnailVersionSequence = Math.max(
    thumbnailVersionSequence + 1,
    Date.now(),
    (prior?.version || 0) + 1,
  );
  return thumbnailVersionSequence;
}

function pruneThumbnailRequests(now: number) {
  for (const [id, timestamp] of thumbnailRequests) {
    if (now - timestamp > THUMBNAIL_REQUEST_RETENTION_MS) {
      thumbnailRequests.delete(id);
    }
  }
}

export function hasThumbnail(id: string): boolean {
  return thumbnails.has(id);
}

export function getThumbnailRecord(id: string): ThumbnailRecord | null {
  const rec = thumbnails.get(id);
  if (!rec) return null;
  touchThumbnailLRU(id);
  return rec;
}

export function getThumbnailVersion(id: string): number {
  return thumbnails.get(id)?.version ?? 0;
}

export type ThumbnailSummary = {
  hasThumbnail: boolean;
  thumbnailVersion: number;
};

export function getThumbnailSummaries(ids: readonly string[]): Map<string, ThumbnailSummary> {
  const summaries = new Map<string, ThumbnailSummary>();
  for (const id of ids) {
    const thumbnail = thumbnails.get(id);
    summaries.set(id, {
      hasThumbnail: !!thumbnail,
      thumbnailVersion: thumbnail?.version ?? 0,
    });
  }
  return summaries;
}

export function clearThumbnail(id: string) {
  deleteCachedThumbnail(id);
  deleteLatestFrame(id);
  thumbnailRequests.delete(id);
}

export function setLatestFrame(id: string, bytes: Uint8Array, format: string): boolean {
  const rawFormat = typeof format === "string" && format.length <= 4
    ? format.toLowerCase()
    : "";
  const normalizedFormat = rawFormat === "jpg" ? "jpeg" : rawFormat;
  if (
    !bytes
    || bytes.byteLength === 0
    || bytes.byteLength > MAX_THUMBNAIL_SOURCE_BYTES
    || (normalizedFormat !== "jpeg" && normalizedFormat !== "webp")
  ) {
    deleteLatestFrame(id);
    return false;
  }
  const existing = latestFrames.get(id);
  const nextCount = latestFrames.size + (existing ? 0 : 1);
  const nextBytes = latestFrameBytes - (existing?.bytes.byteLength || 0) + bytes.byteLength;
  if (
    nextCount > MAX_PENDING_THUMBNAIL_FRAMES
    || nextBytes > MAX_PENDING_THUMBNAIL_BYTES
  ) {
    return false;
  }

  // Store an exact-size copy. A small view can otherwise retain an arbitrarily
  // large WebSocket/message backing buffer until image generation completes.
  const retainedBytes = Uint8Array.from(bytes);
  if (existing) latestFrames.delete(id);
  latestFrames.set(id, { bytes: retainedBytes, format: normalizedFormat, capturedAt: Date.now() });
  latestFrameBytes = nextBytes;
  return true;
}

async function buildThumbnailBytes(bytes: Uint8Array, format: string): Promise<Uint8Array | null> {
  if (!bytes || bytes.byteLength === 0) {
    return null;
  }

  const inputFormat = format === "jpg" ? "jpeg" : format;
  if (!["jpeg", "webp"].includes(inputFormat)) {
    return null;
  }

  const BunImage = getBunImage();
  if (!BunImage) {
    return null;
  }

  const output = await new BunImage(bytes, {
    autoOrient: true,
    maxPixels: THUMBNAIL_WIDTH * THUMBNAIL_HEIGHT * 16,
  })
    .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: THUMBNAIL_QUALITY })
    .bytes();

  return new Uint8Array(output);
}

export async function generateThumbnail(id: string): Promise<boolean> {
  const frameData = latestFrames.get(id);
  if (!frameData) {
    return false;
  }

  try {
    const out = await buildThumbnailBytes(frameData.bytes, frameData.format);
    if (!out || out.byteLength > THUMBNAIL_CACHE_MAX_BYTES) {
      return false;
    }
    const prior = thumbnails.get(id);
    const now = Date.now();
    const newVersion = nextThumbnailVersion(prior);
    if (prior) deleteCachedThumbnail(id);
    thumbnails.set(id, {
      bytes: out,
      contentType: "image/webp",
      version: newVersion,
      updatedAt: now,
    });
    cachedThumbnailBytes += out.byteLength;
    evictThumbnailsIfFull();
    return true;
  } catch (err) {
    if (getBunImage()) {
      console.error(`[thumbnails] Failed to generate thumbnail for client ${id}:`, err);
    }
    return false;
  } finally {
    // Invalid/unsupported sources must not occupy the pending-frame budget
    // indefinitely. Preserve a newer frame that arrived during generation.
    deleteLatestFrame(id, frameData);
  }
}

const thumbnailGenState = new Map<string, { inFlight: boolean; pending: boolean }>();

export async function requestThumbnailRegen(id: string): Promise<boolean> {
  if (!latestFrames.has(id)) return false;
  let state = thumbnailGenState.get(id);
  if (!state) {
    state = { inFlight: false, pending: false };
    thumbnailGenState.set(id, state);
  }
  if (state.inFlight) {
    state.pending = true;
    return false;
  }
  state.inFlight = true;
  let didGenerate = false;
  try {
    const scheduled = await thumbnailScheduler.run(async () => {
      while (true) {
        state!.pending = false;
        const ok = await generateThumbnail(id);
        if (ok) didGenerate = true;
        if (!state!.pending) break;
      }
    });
    if (!scheduled.accepted) {
      deleteLatestFrame(id);
      return false;
    }
  } finally {
    state.inFlight = false;
    if (thumbnailGenState.get(id) === state && !state.pending) {
      thumbnailGenState.delete(id);
    }
  }
  return didGenerate;
}

export function markThumbnailRequested(id: string): boolean {
  const now = Date.now();
  pruneThumbnailRequests(now);
  if (!thumbnailRequests.has(id) && thumbnailRequests.size >= MAX_THUMBNAIL_REQUEST_IDS) {
    return false;
  }
  thumbnailRequests.delete(id);
  thumbnailRequests.set(id, now);
  return true;
}

export function isThumbnailRequested(id: string, windowMs = 5000): boolean {
  const ts = thumbnailRequests.get(id);
  if (!ts) return false;
  if (Date.now() - ts > windowMs) {
    thumbnailRequests.delete(id);
    return false;
  }
  return true;
}

export function clearThumbnailRequest(id: string) {
  thumbnailRequests.delete(id);
}

export function getThumbnailStats(): {
  cachedCount: number;
  cachedBytes: number;
  pendingFrames: number;
  pendingFrameBytes: number;
  genActive: number;
  genQueued: number;
  genStateTracked: number;
  requestIdsTracked: number;
  waiterIdsTracked: number;
  waitersTracked: number;
  cacheMax: number;
  cacheMaxBytes: number;
  pendingFrameMax: number;
  pendingFrameMaxBytes: number;
  genQueueMax: number;
  requestIdMax: number;
  waiterIdMax: number;
  waiterMax: number;
} {
  pruneThumbnailRequests(Date.now());
  const schedulerStats = thumbnailScheduler.getStats();
  return {
    cachedCount: thumbnails.size,
    cachedBytes: cachedThumbnailBytes,
    pendingFrames: latestFrames.size,
    pendingFrameBytes: latestFrameBytes,
    genActive: schedulerStats.active,
    genQueued: schedulerStats.queued,
    genStateTracked: thumbnailGenState.size,
    requestIdsTracked: thumbnailRequests.size,
    waiterIdsTracked: thumbnailWaiters.size,
    waitersTracked: thumbnailWaiterCount,
    cacheMax: THUMBNAIL_CACHE_MAX,
    cacheMaxBytes: THUMBNAIL_CACHE_MAX_BYTES,
    pendingFrameMax: MAX_PENDING_THUMBNAIL_FRAMES,
    pendingFrameMaxBytes: MAX_PENDING_THUMBNAIL_BYTES,
    genQueueMax: MAX_QUEUED_THUMBNAIL_GEN,
    requestIdMax: MAX_THUMBNAIL_REQUEST_IDS,
    waiterIdMax: MAX_THUMBNAIL_WAITER_IDS,
    waiterMax: MAX_THUMBNAIL_WAITERS,
  };
}

export function consumeThumbnailRequest(id: string, windowMs = 5000): boolean {
  const ts = thumbnailRequests.get(id);
  if (!ts) return false;
  if (Date.now() - ts > windowMs) {
    thumbnailRequests.delete(id);
    return false;
  }
  thumbnailRequests.delete(id);
  return true;
}

const thumbnailWaiters = new Map<string, Set<() => void>>();
let thumbnailWaiterCount = 0;

export function notifyThumbnailGenerated(id: string) {
  const waiters = thumbnailWaiters.get(id);
  if (!waiters) return;
  thumbnailWaiters.delete(id);
  thumbnailWaiterCount = Math.max(0, thumbnailWaiterCount - waiters.size);
  for (const cb of waiters) {
    try { cb(); } catch {}
  }
}

export function waitForThumbnail(id: string, timeoutMs = 2500): Promise<boolean> {
  const existingSet = thumbnailWaiters.get(id);
  if (
    (!existingSet && thumbnailWaiters.size >= MAX_THUMBNAIL_WAITER_IDS)
    || thumbnailWaiterCount >= MAX_THUMBNAIL_WAITERS
    || (existingSet?.size || 0) >= MAX_THUMBNAIL_WAITERS_PER_ID
  ) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let settled = false;
    let callback: () => void;
    const finish = (fresh: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const set = thumbnailWaiters.get(id);
      if (set) {
        if (set.delete(callback)) {
          thumbnailWaiterCount = Math.max(0, thumbnailWaiterCount - 1);
        }
        if (set.size === 0) thumbnailWaiters.delete(id);
      }
      resolve(fresh);
    };
    callback = () => finish(true);
    const boundedTimeoutMs = Number.isFinite(timeoutMs)
      ? Math.min(MAX_THUMBNAIL_WAITER_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs)))
      : 2500;
    const timer = setTimeout(() => finish(false), boundedTimeoutMs);
    let set = thumbnailWaiters.get(id);
    if (!set) {
      set = new Set();
      thumbnailWaiters.set(id, set);
    }
    set.add(callback);
    thumbnailWaiterCount += 1;
  });
}
