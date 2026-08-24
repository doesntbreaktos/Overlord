import { describe, expect, test } from "bun:test";
import {
  MAX_PENDING_THUMBNAIL_FRAMES,
  MAX_QUEUED_THUMBNAIL_GEN,
  MAX_THUMBNAIL_REQUEST_IDS,
  MAX_THUMBNAIL_SOURCE_BYTES,
  MAX_THUMBNAIL_WAITER_IDS,
  clearThumbnail,
  clearThumbnailRequest,
  createBoundedThumbnailScheduler,
  generateThumbnail,
  getThumbnailStats,
  getThumbnailVersion,
  markThumbnailRequested,
  notifyThumbnailGenerated,
  requestThumbnailRegen,
  setLatestFrame,
  waitForThumbnail,
} from "./thumbnails";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("thumbnail fleet resource bounds", () => {
  test("generation scheduler rejects work beyond its bounded queue", async () => {
    const scheduler = createBoundedThumbnailScheduler(1, 2);
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const jobs = gates.map((gate) => scheduler.run(() => gate.promise));

    expect(scheduler.getStats()).toEqual({ active: 1, queued: 2 });
    const rejected = await scheduler.run(async () => undefined);
    expect(rejected).toEqual({ accepted: false });
    expect(scheduler.getStats()).toEqual({ active: 1, queued: 2 });

    gates[0]!.resolve();
    expect(await jobs[0]).toEqual({ accepted: true, value: undefined });
    await Promise.resolve();
    expect(scheduler.getStats()).toEqual({ active: 1, queued: 1 });

    gates[1]!.resolve();
    await jobs[1];
    gates[2]!.resolve();
    await jobs[2];
    await Promise.resolve();
    expect(scheduler.getStats()).toEqual({ active: 0, queued: 0 });
  });

  test("pending source frames are admitted only up to the fleet count cap", () => {
    const prefix = `pending-${crypto.randomUUID()}`;
    const ids: string[] = [];
    try {
      for (let index = 0; index < MAX_PENDING_THUMBNAIL_FRAMES; index += 1) {
        const id = `${prefix}-${index}`;
        ids.push(id);
        expect(setLatestFrame(id, new Uint8Array([index & 0xff]), "jpeg")).toBe(true);
      }
      const rejectedId = `${prefix}-rejected`;
      ids.push(rejectedId);
      expect(setLatestFrame(rejectedId, new Uint8Array([1]), "jpeg")).toBe(false);

      const stats = getThumbnailStats();
      expect(stats.pendingFrames).toBe(MAX_PENDING_THUMBNAIL_FRAMES);
      expect(stats.pendingFrameBytes).toBe(MAX_PENDING_THUMBNAIL_FRAMES);
      expect(stats.pendingFrameMax).toBe(MAX_PENDING_THUMBNAIL_FRAMES);
      expect(stats.genQueueMax).toBe(MAX_QUEUED_THUMBNAIL_GEN);
    } finally {
      for (const id of ids) clearThumbnail(id);
    }
    expect(getThumbnailStats().pendingFrames).toBe(0);
  });

  test("oversized and failed sources release pending-frame accounting", async () => {
    const oversizedId = `oversized-${crypto.randomUUID()}`;
    expect(
      setLatestFrame(
        oversizedId,
        new Uint8Array(MAX_THUMBNAIL_SOURCE_BYTES + 1),
        "jpeg",
      ),
    ).toBe(false);

    const invalidId = `invalid-${crypto.randomUUID()}`;
    expect(setLatestFrame(invalidId, new Uint8Array([1, 2, 3]), "x".repeat(4 * 1024 * 1024))).toBe(false);
    expect(setLatestFrame(invalidId, new Uint8Array([1, 2, 3]), "gif")).toBe(false);
    expect(await generateThumbnail(invalidId)).toBe(false);

    const failedId = `failed-${crypto.randomUUID()}`;
    expect(setLatestFrame(failedId, new Uint8Array([1, 2, 3]), "jpeg")).toBe(true);
    const originalImage = (Bun as any).Image;
    try {
      (Bun as any).Image = undefined;
      expect(await generateThumbnail(failedId)).toBe(false);
    } finally {
      (Bun as any).Image = originalImage;
    }
    expect(getThumbnailStats().pendingFrames).toBe(0);
  });

  test("requests without a retained source do not create generation work", async () => {
    const prefix = `empty-${crypto.randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: MAX_QUEUED_THUMBNAIL_GEN + 10 }, (_, index) =>
        requestThumbnailRegen(`${prefix}-${index}`)),
    );
    expect(results.every((value) => value === false)).toBe(true);
    const stats = getThumbnailStats();
    expect(stats.genActive).toBe(0);
    expect(stats.genQueued).toBe(0);
    expect(stats.genStateTracked).toBe(0);
  });

  test("generated cache bytes stay bounded and versions survive cache clears", async () => {
    const originalImage = (Bun as any).Image;
    class FakeImage {
      resize() {
        return {
          webp: () => ({ bytes: async () => new Uint8Array([1]) }),
        };
      }
    }
    (Bun as any).Image = FakeImage;
    const prefix = `metadata-${crypto.randomUUID()}`;
    const ids: string[] = [];
    try {
      const cacheMax = getThumbnailStats().cacheMax;
      for (let index = 0; index <= cacheMax; index += 1) {
        const id = `${prefix}-${index}`;
        ids.push(id);
        if (!setLatestFrame(id, new Uint8Array([1]), "jpeg")) {
          throw new Error("test frame unexpectedly rejected");
        }
        if (!await generateThumbnail(id)) {
          throw new Error("test thumbnail unexpectedly failed");
        }
      }
      const reconnectId = ids[ids.length - 1]!;
      const versionBeforeClear = getThumbnailVersion(reconnectId);
      expect(versionBeforeClear).toBeGreaterThan(0);
      clearThumbnail(reconnectId);
      expect(setLatestFrame(reconnectId, new Uint8Array([1]), "jpeg")).toBe(true);
      expect(await generateThumbnail(reconnectId)).toBe(true);
      expect(getThumbnailVersion(reconnectId)).toBeGreaterThan(versionBeforeClear);

      const stats = getThumbnailStats();
      expect(stats.cachedCount).toBe(stats.cacheMax);
      expect(stats.cachedBytes).toBe(stats.cachedCount);
      expect(stats.cachedBytes).toBeLessThanOrEqual(stats.cacheMaxBytes);
    } finally {
      (Bun as any).Image = originalImage;
      for (const id of ids) clearThumbnail(id);
    }
    expect(getThumbnailStats().cachedBytes).toBe(0);
  });

  test("request markers have a hard fleet identity cap", () => {
    const prefix = `request-${crypto.randomUUID()}`;
    const ids: string[] = [];
    try {
      for (let index = 0; index < MAX_THUMBNAIL_REQUEST_IDS; index += 1) {
        const id = `${prefix}-${index}`;
        ids.push(id);
        expect(markThumbnailRequested(id)).toBe(true);
      }
      expect(markThumbnailRequested(`${prefix}-rejected`)).toBe(false);
      expect(getThumbnailStats().requestIdsTracked).toBe(MAX_THUMBNAIL_REQUEST_IDS);
    } finally {
      for (const id of ids) clearThumbnailRequest(id);
    }
  });

  test("waiter identities are bounded and released after notification", async () => {
    const prefix = `waiter-${crypto.randomUUID()}`;
    const ids = Array.from(
      { length: MAX_THUMBNAIL_WAITER_IDS },
      (_, index) => `${prefix}-${index}`,
    );
    const waiters = ids.map((id) => waitForThumbnail(id, 10_000));
    expect(getThumbnailStats().waiterIdsTracked).toBe(MAX_THUMBNAIL_WAITER_IDS);
    expect(await waitForThumbnail(`${prefix}-rejected`, 10_000)).toBe(false);

    for (const id of ids) notifyThumbnailGenerated(id);
    expect((await Promise.all(waiters)).every(Boolean)).toBe(true);
    const stats = getThumbnailStats();
    expect(stats.waiterIdsTracked).toBe(0);
    expect(stats.waitersTracked).toBe(0);
  });
});
