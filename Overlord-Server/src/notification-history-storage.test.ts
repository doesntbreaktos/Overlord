import { describe, expect, test } from "bun:test";
import Database from "bun:sqlite";
import {
  createNotificationSaver,
  notificationPayloadBytes,
  type NotificationHistoryQuotaLimits,
  type NotificationRow,
} from "./db/repositories";

const generousLimits: NotificationHistoryQuotaLimits = {
  perClientCount: 10_000,
  perClientBytes: 128 * 1024 * 1024,
  globalCount: 100_000,
  globalBytes: 1024 * 1024 * 1024,
};

function createHarness(limits: NotificationHistoryQuotaLimits = generousLimits) {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      host TEXT,
      user TEXT,
      os TEXT,
      title TEXT NOT NULL,
      process TEXT,
      process_path TEXT,
      detail TEXT,
      pid INTEGER,
      keyword TEXT,
      category TEXT NOT NULL DEFAULT 'active_window',
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
  return {
    database,
    save: createNotificationSaver(database as any, () => limits),
  };
}

function notification(
  id: string,
  clientId: string,
  ts: number,
  detail = "",
): NotificationRow {
  return {
    id,
    clientId,
    host: "host",
    user: "user",
    os: "windows",
    title: `title-${id}`,
    process: "process.exe",
    processPath: "C:\\process.exe",
    detail,
    keyword: "keyword",
    category: "active_window",
    ts,
  };
}

describe("notification history storage quotas", () => {
  test("prunes the oldest per-client row and its linked screenshot", () => {
    const { database, save } = createHarness({ ...generousLimits, perClientCount: 2 });
    try {
      expect(save(notification("n1", "client-a", 1))).toBe(true);
      expect(save(notification("n2", "client-a", 2))).toBe(true);
      database.run(
        `INSERT INTO notification_screenshots
          (id, notification_id, client_id, ts, format, width, height, bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["shot-1", "n1", "client-a", 1, "jpeg", 1, 1, new Uint8Array([1])],
      );
      database.run("UPDATE notifications SET screenshot_id='shot-1' WHERE id='n1'");

      expect(save(notification("n3", "client-a", 3))).toBe(true);
      expect(database.query(
        "SELECT id FROM notifications ORDER BY ts",
      ).all()).toEqual([{ id: "n2" }, { id: "n3" }]);
      expect((database.query(
        "SELECT COUNT(*) AS count FROM notification_screenshots",
      ).get() as { count: number }).count).toBe(0);
    } finally {
      database.close();
    }
  });

  test("enforces the global count cap across distinct client identities", () => {
    const { database, save } = createHarness({ ...generousLimits, globalCount: 2 });
    try {
      expect(save(notification("n1", "client-a", 1))).toBe(true);
      expect(save(notification("n2", "client-b", 2))).toBe(true);
      expect(save(notification("n3", "client-c", 3))).toBe(true);

      expect(database.query(
        "SELECT id, client_id FROM notifications ORDER BY ts",
      ).all()).toEqual([
        { id: "n2", client_id: "client-b" },
        { id: "n3", client_id: "client-c" },
      ]);
    } finally {
      database.close();
    }
  });

  test("uses UTF-8 payload bytes to enforce per-client retention", () => {
    const first = notification("n1", "client-a", 1, "é".repeat(200));
    const second = notification("n2", "client-a", 2, "界".repeat(200));
    const oneRowLimit = Math.max(
      notificationPayloadBytes(first),
      notificationPayloadBytes(second),
    );
    const { database, save } = createHarness({
      ...generousLimits,
      perClientBytes: oneRowLimit,
    });
    try {
      expect(save(first)).toBe(true);
      expect(save(second)).toBe(true);
      expect(database.query(
        "SELECT id FROM notifications",
      ).all()).toEqual([{ id: "n2" }]);
    } finally {
      database.close();
    }
  });

  test("rejects a single oversized row without evicting retained history", () => {
    const retained = notification("retained", "client-a", 1, "small");
    const oversized = notification("oversized", "client-a", 2, "x".repeat(5_000));
    const limit = notificationPayloadBytes(retained) + 10;
    const { database, save } = createHarness({
      ...generousLimits,
      perClientBytes: limit,
      globalBytes: limit,
    });
    try {
      expect(save(retained)).toBe(true);
      expect(save(oversized)).toBe(false);
      expect(database.query(
        "SELECT id FROM notifications",
      ).all()).toEqual([{ id: "retained" }]);
    } finally {
      database.close();
    }
  });

  test("rolls back cleanup if the admitted notification write fails", () => {
    const { database, save } = createHarness({
      ...generousLimits,
      globalCount: 1,
    });
    try {
      expect(save(notification("retained", "client-a", 1))).toBe(true);
      database.exec(`
        CREATE TRIGGER reject_incoming_notification BEFORE INSERT ON notifications
        WHEN new.id = 'incoming'
        BEGIN
          SELECT RAISE(ABORT, 'injected failure');
        END;
      `);

      expect(() => save(notification("incoming", "client-b", 2))).toThrow();
      expect(database.query(
        "SELECT id FROM notifications",
      ).all()).toEqual([{ id: "retained" }]);
    } finally {
      database.close();
    }
  });

  test("commits bounded cleanup while preserving a rejected replacement row", () => {
    const { database, save } = createHarness({
      ...generousLimits,
      globalCount: 1,
    });
    try {
      const insert = database.prepare(
        `INSERT INTO notifications
          (id, client_id, title, category, ts)
         VALUES (?, ?, ?, ?, ?)`,
      );
      database.transaction(() => {
        insert.run("incoming", "new-client", "protected-old", "active_window", 0);
        for (let i = 0; i < 2_001; i += 1) {
          insert.run(`old-${i}`, `client-${i}`, "old", "active_window", i + 1);
        }
      })();

      expect(save(notification("incoming", "new-client", 10_000))).toBe(false);
      expect((database.query(
        "SELECT COUNT(*) AS count FROM notifications",
      ).get() as { count: number }).count).toBe(2);
      expect(database.query(
        "SELECT title FROM notifications WHERE id='incoming'",
      ).get()).toEqual({ title: "protected-old" });
      expect(database.query(
        "SELECT id FROM notifications WHERE id<>'incoming'",
      ).all()).toEqual([{ id: "old-2000" }]);

      expect(save(notification("incoming", "new-client", 10_000))).toBe(true);
      expect(database.query(
        "SELECT id, title FROM notifications",
      ).all()).toEqual([{ id: "incoming", title: "title-incoming" }]);
    } finally {
      database.close();
    }
  });
});
