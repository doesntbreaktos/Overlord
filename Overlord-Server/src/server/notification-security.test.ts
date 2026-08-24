import { describe, expect, test } from "bun:test";
import {
  MAX_NOTIFICATION_SCREENSHOT_BYTES,
  validateNotificationScreenshotPayload,
} from "./notification-delivery";
import {
  MAX_BUFFERED_PLUGIN_EVENT_BYTES_GLOBAL,
  MAX_BUFFERED_PLUGIN_EVENT_BYTES_PER_CLIENT,
  MAX_BUFFERED_PLUGIN_EVENT_BYTES_PER_KEY,
  MAX_PLUGIN_EVENT_PAYLOAD_BYTES,
  MAX_PLUGIN_EVENTS_PER_KEY_PER_MINUTE,
  MAX_PENDING_NOTIFICATION_SCREENSHOTS,
  createNotificationPluginHandlers,
  hasPendingNotificationScreenshotCapacity,
  hasPluginUIEventBufferCapacity,
  isPlausibleChatAttachmentEventPayload,
  normalizeClientNotificationPayload,
  type PendingNotificationScreenshot,
} from "./ws-notifications-plugin";

function createPluginEventHarness(enabledPluginIds = ["sample", "chat"]) {
  const pluginLoadedByClient = new Map<string, Set<string>>();
  const pluginLoadingByClient = new Map<string, Set<string>>();
  const forwarded: Array<{ clientId: string; pluginId: string; event: string; payload: unknown }> = [];
  const pluginState = {
    enabled: Object.fromEntries(enabledPluginIds.map((id) => [id, true])),
    lastError: {} as Record<string, string>,
  };
  let saveCount = 0;
  const handlers = createNotificationPluginHandlers({
    notificationRate: new Map(),
    pendingNotificationScreenshots: new Map(),
    pluginLoadedByClient,
    pluginLoadingByClient,
    pendingPluginEvents: new Map(),
    pluginState,
    getNotificationConfig: () => ({}),
    canUserAccessClient: () => false,
    isClientOwnedByUser: () => false,
    getUserRole: () => undefined,
    isClientNotificationsMuted: () => false,
    storeNotificationScreenshot: () => {},
    deliverNotificationWithScreenshot: async () => {},
    getDeliveryTargetsForClientEvent: () => [],
    savePluginState: async () => { saveCount += 1; },
    forwardPluginEventToRuntime: (clientId, pluginId, event, payload) => {
      forwarded.push({ clientId, pluginId, event, payload });
    },
  });
  return {
    handlers,
    forwarded,
    pluginLoadedByClient,
    pluginLoadingByClient,
    pluginState,
    getSaveCount: () => saveCount,
  };
}

describe("client notification input hardening", () => {
  test("bounds and normalizes untrusted notification fields", () => {
    const normalized = normalizeClientNotificationPayload({
      title: `  hello\n${"x".repeat(600)}  `,
      keyword: "k".repeat(200),
      process: "p".repeat(400),
      processPath: "z".repeat(3_000),
      pid: -1,
      category: "unexpected",
      ts: Number.MAX_SAFE_INTEGER,
    });

    expect(normalized).not.toBeNull();
    expect(normalized!.title.length).toBe(512);
    expect(normalized!.title.includes("\n")).toBe(false);
    expect(normalized!.keyword?.length).toBe(128);
    expect(normalized!.process?.length).toBe(256);
    expect(normalized!.processPath?.length).toBe(2_048);
    expect(normalized!.pid).toBeUndefined();
    expect(normalized!.category).toBe("active_window");
    expect(normalized as any).not.toHaveProperty("ts");
  });

  test("rejects empty titles", () => {
    expect(normalizeClientNotificationPayload({ title: "\u0000\n" })).toBeNull();
  });
});

describe("notification screenshot input hardening", () => {
  test("accepts supported bounded images and preserves typed-array bounds", () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
      0xff, 0xd9,
    ]);
    const backing = new Uint8Array(jpeg.length + 2);
    backing.set(jpeg, 1);
    const validated = validateNotificationScreenshotPayload({
      data: backing.subarray(1, 1 + jpeg.length),
      format: "JPG",
      width: 1,
      height: 1,
    });

    expect(validated?.format).toBe("jpeg");
    expect(Array.from(validated?.bytes ?? [])).toEqual(Array.from(jpeg));
    expect(validated?.width).toBe(1);
    expect(validated?.height).toBe(1);
  });

  test("rejects oversized or unsupported screenshot payloads", () => {
    expect(
      validateNotificationScreenshotPayload({
        data: new Uint8Array(MAX_NOTIFICATION_SCREENSHOT_BYTES + 1),
        format: "jpeg",
      }),
    ).toBeNull();
    expect(
      validateNotificationScreenshotPayload({ data: new Uint8Array([1]), format: "svg" }),
    ).toBeNull();
    expect(
      validateNotificationScreenshotPayload({ data: new Uint8Array([1, 2, 3]), format: "jpeg" }),
    ).toBeNull();
  });

  test("rejects tiny compressed images with unsafe decoded dimensions", () => {
    const png = Buffer.alloc(57);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(32_768, 16);
    png.writeUInt32BE(32_768, 20);
    png.writeUInt32BE(0, 33);
    png.write("IDAT", 37, "ascii");
    png.writeUInt32BE(0, 45);
    png.write("IEND", 49, "ascii");

    expect(validateNotificationScreenshotPayload({ data: png, format: "png" })).toBeNull();
  });

  test("rejects animated PNG envelopes", () => {
    const png = Buffer.alloc(57);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(1, 16);
    png.writeUInt32BE(1, 20);
    png.writeUInt32BE(0, 33);
    png.write("IDAT", 37, "ascii");
    png.writeUInt32BE(0, 45);
    png.write("IEND", 49, "ascii");
    const animationControl = Buffer.alloc(20);
    animationControl.writeUInt32BE(8, 0);
    animationControl.write("acTL", 4, "ascii");
    animationControl.writeUInt32BE(2, 8);
    const apng = Buffer.concat([png.subarray(0, 33), animationControl, png.subarray(33)]);

    expect(validateNotificationScreenshotPayload({ data: apng, format: "png" })).toBeNull();
  });

  test("bounds pending screenshot requests globally and per client", () => {
    const now = Date.now();
    const sharedTimeout = setTimeout(() => {}, 60_000);
    const pending = new Map<string, PendingNotificationScreenshot>();
    try {
      for (let i = 0; i < 2; i += 1) {
        pending.set(`same-client-${i}`, {
          notificationId: `notification-${i}`,
          clientId: "client-a",
          ts: now,
          timeout: sharedTimeout,
        });
      }
      expect(hasPendingNotificationScreenshotCapacity(pending, "client-a", now)).toBe(false);
      expect(hasPendingNotificationScreenshotCapacity(pending, "client-b", now)).toBe(true);

      pending.clear();
      for (let i = 0; i < MAX_PENDING_NOTIFICATION_SCREENSHOTS; i += 1) {
        pending.set(`global-${i}`, {
          notificationId: `notification-${i}`,
          clientId: `client-${i}`,
          ts: now,
          timeout: sharedTimeout,
        });
      }
      expect(hasPendingNotificationScreenshotCapacity(pending, "new-client", now)).toBe(false);
    } finally {
      clearTimeout(sharedTimeout);
    }
  });

  test("prunes expired pending screenshot requests before applying caps", () => {
    const now = Date.now();
    const timeout = setTimeout(() => {}, 60_000);
    const pending = new Map<string, PendingNotificationScreenshot>([[
      "expired",
      {
        notificationId: "old-notification",
        clientId: "client-a",
        ts: now - 31_000,
        timeout,
      },
    ]]);

    expect(hasPendingNotificationScreenshotCapacity(pending, "client-a", now)).toBe(true);
    expect(pending.size).toBe(0);
    clearTimeout(timeout);
  });
});

describe("legacy client plugin event compatibility", () => {
  test("accepts plugin lifecycle and ordinary events without server-side trust state", () => {
    const harness = createPluginEventHarness([]);
    harness.handlers.handlePluginEvent("client-a", {
      pluginId: "sample-c",
      event: "ready",
      payload: { ready: true },
    });
    harness.handlers.handlePluginEvent("client-a", {
      pluginId: "sample-c",
      event: "loaded",
    });

    expect(harness.forwarded.map((entry) => entry.event)).toEqual(["ready", "loaded"]);
    expect(harness.pluginLoadedByClient.get("client-a")?.has("sample-c")).toBe(true);
  });
});

// Retained as executable documentation of the stricter policy that was
// deliberately reversed because it broke established third-party plugins.
/*
describe("replaced client plugin event hardening", () => {
  test("only accepts loaded acknowledgements for server-initiated plugin loads", () => {
    const harness = createPluginEventHarness();

    harness.handlers.handlePluginEvent("client-a", {
      pluginId: "sample",
      event: "loaded",
    });
    expect(harness.pluginLoadedByClient.get("client-a")).toBeUndefined();
    expect(harness.forwarded).toHaveLength(0);

    harness.handlers.markPluginLoading("client-a", "sample");
    harness.handlers.handlePluginEvent("client-a", {
      pluginId: "sample",
      event: "ready",
      payload: { ready: true },
    });
    expect(harness.forwarded.map((entry) => entry.event)).toEqual(["ready"]);

    harness.handlers.handlePluginEvent("client-a", {
      pluginId: "sample",
      event: "loaded",
    });
    expect(harness.pluginLoadedByClient.get("client-a")?.has("sample")).toBe(true);
    expect(harness.pluginLoadingByClient.get("client-a")?.has("sample")).toBe(false);
    expect(harness.forwarded.map((entry) => entry.event)).toEqual(["ready", "loaded"]);

    harness.handlers.handlePluginEvent("client-a", {
      pluginId: "sample",
      event: "loaded",
    });
    expect(harness.forwarded.map((entry) => entry.event)).toEqual(["ready", "loaded"]);
  });

  test("rejects ordinary events until loaded but permits a load failure", () => {
    const harness = createPluginEventHarness();
    harness.handlers.handlePluginEvent("client-a", {
      pluginId: "sample",
      event: "pong",
      payload: { ok: true },
    });
    expect(harness.forwarded).toHaveLength(0);

    harness.handlers.markPluginLoading("client-a", "sample");
    harness.handlers.handlePluginEvent("client-a", {
      pluginId: "sample",
      event: "error",
      error: "load failed",
    });
    expect(harness.forwarded.map((entry) => entry.event)).toEqual(["error"]);
    expect(harness.pluginLoadingByClient.get("client-a")?.has("sample")).toBe(false);
    expect(harness.pluginState.lastError.sample).toBe("load failed");
    expect(harness.getSaveCount()).toBe(1);
  });

  test("ordinary plugin messages cannot mutate or persist error state", () => {
    const harness = createPluginEventHarness();
    harness.pluginLoadedByClient.set("client-a", new Set(["sample"]));

    harness.handlers.handlePluginEvent("client-a", {
      pluginId: "sample",
      event: "pong",
      message: "pretend failure",
      payload: { ok: true },
    });

    expect(harness.forwarded.map((entry) => entry.event)).toEqual(["pong"]);
    expect(harness.pluginState.lastError.sample).toBeUndefined();
    expect(harness.getSaveCount()).toBe(0);
  });

  test("coalesces repeated changed error state writes from a loaded client", () => {
    const harness = createPluginEventHarness();
    harness.pluginLoadedByClient.set("client-a", new Set(["sample"]));

    for (const message of ["failure one", "failure two", "failure three"]) {
      harness.handlers.handlePluginEvent("client-a", {
        pluginId: "sample",
        event: "error",
        message,
      });
    }

    expect(harness.pluginState.lastError.sample).toBe("failure three");
    expect(harness.getSaveCount()).toBe(1);
  });

  test("uses a small default payload limit with a narrow chat attachment exception", () => {
    const harness = createPluginEventHarness();
    harness.pluginLoadedByClient.set("client-a", new Set(["sample", "chat"]));
    const aboveDefault = {
      name: "image.png",
      mime: "image/png",
      dataB64: "A".repeat(MAX_PLUGIN_EVENT_PAYLOAD_BYTES + 4),
    };

    harness.handlers.handlePluginEvent("client-a", {
      pluginId: "sample",
      event: "echo",
      payload: aboveDefault,
    });
    expect(harness.forwarded).toHaveLength(0);

    harness.handlers.handlePluginEvent("client-a", {
      pluginId: "chat",
      event: "chat_attachment",
      payload: aboveDefault,
    });
    expect(harness.forwarded.map((entry) => entry.event)).toEqual(["chat_attachment"]);
    expect(harness.handlers.drainPluginUIEvents("client-a", "chat")).toEqual([]);

    expect(isPlausibleChatAttachmentEventPayload({
      mime: "text/html",
      dataB64: "AAAA",
    })).toBe(false);
  });

  test("rate limits repeated events per client/plugin key", () => {
    const harness = createPluginEventHarness();
    harness.pluginLoadedByClient.set("client-a", new Set(["sample"]));
    for (let i = 0; i < MAX_PLUGIN_EVENTS_PER_KEY_PER_MINUTE + 5; i += 1) {
      harness.handlers.handlePluginEvent("client-a", {
        pluginId: "sample",
        event: "pong",
        payload: { i },
      });
    }
    expect(harness.forwarded).toHaveLength(MAX_PLUGIN_EVENTS_PER_KEY_PER_MINUTE);
  });

  test("evicts old UI events before the per-key byte buffer can grow unbounded", () => {
    const harness = createPluginEventHarness();
    harness.pluginLoadedByClient.set("client-a", new Set(["sample"]));
    const payload = { text: "x".repeat(240 * 1024) };
    for (let i = 0; i < 40; i += 1) {
      harness.handlers.handlePluginEvent("client-a", {
        pluginId: "sample",
        event: "echo",
        payload,
      });
    }

    expect(harness.forwarded).toHaveLength(40);
    const buffered = harness.handlers.drainPluginUIEvents("client-a", "sample");
    expect(buffered.length).toBeGreaterThan(0);
    expect(buffered.length).toBeLessThan(40);
  });

  test("enforces per-key, per-client, and global buffered-byte ceilings", () => {
    expect(hasPluginUIEventBufferCapacity(
      MAX_BUFFERED_PLUGIN_EVENT_BYTES_PER_KEY - 1,
      0,
      0,
      1,
    )).toBe(true);
    expect(hasPluginUIEventBufferCapacity(
      MAX_BUFFERED_PLUGIN_EVENT_BYTES_PER_KEY,
      0,
      0,
      1,
    )).toBe(false);
    expect(hasPluginUIEventBufferCapacity(
      0,
      MAX_BUFFERED_PLUGIN_EVENT_BYTES_PER_CLIENT,
      0,
      1,
    )).toBe(false);
    expect(hasPluginUIEventBufferCapacity(
      0,
      0,
      MAX_BUFFERED_PLUGIN_EVENT_BYTES_GLOBAL,
      1,
    )).toBe(false);
  });
});
*/
