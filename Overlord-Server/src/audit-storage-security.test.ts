import { describe, expect, test } from "bun:test";
import Database from "bun:sqlite";
import { pruneAuditRowsToLimit } from "./auditLog";

function makeAuditDatabase(): Database {
  const database = new Database(":memory:");
  database.run(`
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      username TEXT NOT NULL,
      ip TEXT NOT NULL,
      action TEXT NOT NULL,
      target_client_id TEXT,
      details TEXT,
      success INTEGER NOT NULL,
      error_message TEXT
    )
  `);
  return database;
}

describe("audit storage quota", () => {
  test("prunes the oldest rows in bounded batches", () => {
    const database = makeAuditDatabase();
    try {
      const insert = database.prepare(
        "INSERT INTO audit_logs(timestamp, username, ip, action, success) VALUES (?, 'system', '127.0.0.1', 'test', 1)",
      );
      for (let i = 0; i < 10; i += 1) insert.run(i);

      expect(pruneAuditRowsToLimit(database, 3, 4)).toBe(4);
      expect(database.query("SELECT timestamp FROM audit_logs ORDER BY timestamp").all()).toEqual([
        { timestamp: 4 }, { timestamp: 5 }, { timestamp: 6 },
        { timestamp: 7 }, { timestamp: 8 }, { timestamp: 9 },
      ]);
      expect(pruneAuditRowsToLimit(database, 3, 20)).toBe(3);
      expect(database.query("SELECT timestamp FROM audit_logs ORDER BY timestamp").all()).toEqual([
        { timestamp: 7 }, { timestamp: 8 }, { timestamp: 9 },
      ]);
    } finally {
      database.close();
    }
  });
});
