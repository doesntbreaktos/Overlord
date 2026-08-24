import { describe, expect, test } from "bun:test";
import Database from "bun:sqlite";
import {
  createNotificationScreenshotSaver,
  type NotificationScreenshotQuotaLimits,
  type NotificationScreenshotRecord,
} from "./db/repositories";

const generousLimits: NotificationScreenshotQuotaLimits = {
  perClientCount: 100,
  perClientBytes: 1024 * 1024,
  globalCount: 1_000,
  globalBytes: 16 * 1024 * 1024,
};

function createHarness(limits: NotificationScreenshotQuotaLimits = generousLimits) {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      screenshot_id TEXT
    );
    CREATE TABLE notification_screenshots (
      id TEXT PRIMARY KEY,
      notification_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      format TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      bytes BLOB NOT NULL
    );
  `);
  const save = createNotificationScreenshotSaver(database as any, () => limits);
  return { database, save };
}

function addNotification(database: Database, id: string, clientId: string, ts: number) {
  database.run(
    "INSERT INTO notifications (id, client_id, ts, screenshot_id) VALUES (?, ?, ?, NULL)",
    [id, clientId, ts],
  );
}

function screenshot(
  id: string,
  notificationId: string,
  clientId: string,
  ts: number,
  bytes = 6,
): NotificationScreenshotRecord {
  return {
    id,
    notificationId,
    clientId,
    ts,
    format: "jpeg",
    width: 1,
    height: 1,
    bytes: new Uint8Array(bytes).fill(1),
  };
}

describe("notification screenshot storage quotas", () => {
  test("atomically accepts only one result for a notification", () => {
    const { database, save } = createHarness();
    try {
      addNotification(database, "notification-race", "client-a", 1);

      expect(save(screenshot("shot-first", "notification-race", "client-a", 1))).toBe(true);
      expect(save(screenshot("shot-late", "notification-race", "client-a", 2))).toBe(false);

      const rows = database.query(
        "SELECT id FROM notification_screenshots WHERE notification_id=?",
      ).all("notification-race") as Array<{ id: string }>;
      const notification = database.query(
        "SELECT screenshot_id FROM notifications WHERE id=?",
      ).get("notification-race") as { screenshot_id: string | null } | null;
      expect(rows).toEqual([{ id: "shot-first" }]);
      expect(notification?.screenshot_id).toBe("shot-first");
    } finally {
      database.close();
    }
  });

  test("does not create an orphan when its notification is missing or mismatched", () => {
    const { database, save } = createHarness();
    try {
      addNotification(database, "notification-owned", "client-a", 1);
      expect(save(screenshot("shot-missing", "missing", "client-a", 1))).toBe(false);
      expect(save(screenshot("shot-wrong-client", "notification-owned", "client-b", 1))).toBe(false);
      expect((database.query(
        "SELECT COUNT(*) AS count FROM notification_screenshots",
      ).get() as { count: number } | null)?.count).toBe(0);
    } finally {
      database.close();
    }
  });

  test("prunes the oldest client rows for both count and byte quotas", () => {
    const { database, save } = createHarness({
      ...generousLimits,
      perClientCount: 2,
      perClientBytes: 10,
    });
    try {
      addNotification(database, "notification-1", "client-a", 1);
      addNotification(database, "notification-2", "client-a", 2);
      addNotification(database, "notification-3", "client-a", 3);

      expect(save(screenshot("shot-1", "notification-1", "client-a", 1))).toBe(true);
      expect(save(screenshot("shot-2", "notification-2", "client-a", 2))).toBe(true);
      expect(save(screenshot("shot-3", "notification-3", "client-a", 3))).toBe(true);

      const rows = database.query(
        "SELECT id FROM notification_screenshots ORDER BY ts",
      ).all() as Array<{ id: string }>;
      const pruned = database.query(
        "SELECT screenshot_id FROM notifications WHERE id='notification-2'",
      ).get() as { screenshot_id: string | null } | null;
      expect(rows).toEqual([{ id: "shot-3" }]);
      expect(pruned?.screenshot_id).toBeNull();
    } finally {
      database.close();
    }
  });

  test("enforces a global quota across clients and clears evicted links", () => {
    const { database, save } = createHarness({
      ...generousLimits,
      globalCount: 2,
    });
    try {
      addNotification(database, "notification-global-1", "client-a", 1);
      addNotification(database, "notification-global-2", "client-b", 2);
      addNotification(database, "notification-global-3", "client-c", 3);

      expect(save(screenshot("shot-global-1", "notification-global-1", "client-a", 1))).toBe(true);
      expect(save(screenshot("shot-global-2", "notification-global-2", "client-b", 2))).toBe(true);
      expect(save(screenshot("shot-global-3", "notification-global-3", "client-c", 3))).toBe(true);

      expect(database.query(
        "SELECT id FROM notification_screenshots ORDER BY ts",
      ).all() as Array<{ id: string }>).toEqual([{ id: "shot-global-2" }, { id: "shot-global-3" }]);
      expect((database.query(
        "SELECT screenshot_id FROM notifications WHERE id='notification-global-1'",
      ).get() as { screenshot_id: string | null } | null)?.screenshot_id).toBeNull();
    } finally {
      database.close();
    }
  });

  test("rolls back cleanup and link changes if the screenshot insert fails", () => {
    const { database, save } = createHarness({
      ...generousLimits,
      globalCount: 1,
    });
    try {
      addNotification(database, "notification-retained", "client-a", 1);
      addNotification(database, "notification-incoming", "client-b", 2);
      expect(save(screenshot(
        "shot-retained",
        "notification-retained",
        "client-a",
        1,
      ))).toBe(true);
      database.exec(`
        CREATE TRIGGER reject_incoming_screenshot BEFORE INSERT ON notification_screenshots
        WHEN new.id = 'shot-incoming'
        BEGIN
          SELECT RAISE(ABORT, 'injected failure');
        END;
      `);

      expect(() => save(screenshot(
        "shot-incoming",
        "notification-incoming",
        "client-b",
        2,
      ))).toThrow();
      expect(database.query(
        "SELECT id FROM notification_screenshots",
      ).all()).toEqual([{ id: "shot-retained" }]);
      expect((database.query(
        "SELECT screenshot_id FROM notifications WHERE id='notification-retained'",
      ).get() as { screenshot_id: string | null }).screenshot_id).toBe("shot-retained");
    } finally {
      database.close();
    }
  });

  test("removes legacy orphan rows in the same transaction", () => {
    const { database, save } = createHarness();
    try {
      database.run(
        `INSERT INTO notification_screenshots
          (id, notification_id, client_id, ts, format, width, height, bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["legacy-orphan", "gone", "client-a", 1, "jpeg", 1, 1, new Uint8Array([1])],
      );
      addNotification(database, "notification-live", "client-a", 2);

      expect(save(screenshot("shot-live", "notification-live", "client-a", 2))).toBe(true);
      expect(database.query(
        "SELECT id FROM notification_screenshots ORDER BY id",
      ).all() as Array<{ id: string }>).toEqual([{ id: "shot-live" }]);
    } finally {
      database.close();
    }
  });

  test("commits bounded cleanup when one pass cannot yet admit the screenshot", () => {
    const { database, save } = createHarness({
      perClientCount: 1_000,
      perClientBytes: 1024 * 1024,
      globalCount: 1,
      globalBytes: 16 * 1024 * 1024,
    });
    try {
      database.exec("BEGIN");
      for (let i = 0; i < 252; i += 1) {
        const notificationId = `existing-notification-${i}`;
        const screenshotId = `existing-shot-${i}`;
        database.run(
          "INSERT INTO notifications (id, client_id, ts, screenshot_id) VALUES (?, ?, ?, ?)",
          [notificationId, "existing-client", i, screenshotId],
        );
        database.run(
          `INSERT INTO notification_screenshots
            (id, notification_id, client_id, ts, format, width, height, bytes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [screenshotId, notificationId, "existing-client", i, "jpeg", 1, 1, new Uint8Array([1])],
        );
      }
      database.exec("COMMIT");
      addNotification(database, "notification-over-limit", "new-client", 1_000);

      expect(save(screenshot(
        "shot-over-limit",
        "notification-over-limit",
        "new-client",
        1_000,
      ))).toBe(false);
      expect((database.query(
        "SELECT COUNT(*) AS count FROM notification_screenshots",
      ).get() as { count: number }).count).toBe(2);
      expect(database.query(
        "SELECT id FROM notification_screenshots ORDER BY ts",
      ).all()).toEqual([{ id: "existing-shot-250" }, { id: "existing-shot-251" }]);
      expect((database.query(
        "SELECT screenshot_id FROM notifications WHERE id='notification-over-limit'",
      ).get() as { screenshot_id: string | null }).screenshot_id).toBeNull();

      expect(save(screenshot(
        "shot-over-limit",
        "notification-over-limit",
        "new-client",
        1_000,
      ))).toBe(true);
      expect(database.query(
        "SELECT id FROM notification_screenshots",
      ).all()).toEqual([{ id: "shot-over-limit" }]);
    } finally {
      database.close();
    }
  });
});
