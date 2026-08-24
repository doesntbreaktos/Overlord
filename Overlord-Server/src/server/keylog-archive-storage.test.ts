import { describe, expect, test } from "bun:test";
import Database from "bun:sqlite";
import {
  createKeylogArchiveWriter,
  type KeylogArchiveQuotaLimits,
  type KeylogArchiveRecord,
} from "./keylog-archive";

const generousLimits: KeylogArchiveQuotaLimits = {
  perClientFiles: 100,
  perClientBytes: 1024 * 1024,
  globalFiles: 1_000,
  globalBytes: 16 * 1024 * 1024,
};

function createHarness(limits: KeylogArchiveQuotaLimits = generousLimits) {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE keylog_archive_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      modified_at INTEGER,
      retrieved_at INTEGER NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      UNIQUE(client_id, filename)
    );
    CREATE VIRTUAL TABLE keylog_archive_fts USING fts5(
      file_id UNINDEXED,
      client_id UNINDEXED,
      filename,
      content,
      tokenize = 'unicode61'
    );
  `);
  return {
    database,
    save: createKeylogArchiveWriter(database as any, () => limits),
  };
}

function record(
  clientId: string,
  filename: string,
  retrievedAt: number,
  content: string,
): KeylogArchiveRecord {
  return {
    clientId,
    filename,
    size: Buffer.byteLength(content, "utf8"),
    modifiedAt: retrievedAt,
    retrievedAt,
    content,
  };
}

describe("keylog archive aggregate quotas", () => {
  test("prunes the oldest fleet rows and their FTS entries at the global count cap", () => {
    const { database, save } = createHarness({ ...generousLimits, globalFiles: 2 });
    try {
      expect(save(record("client-a", "a.log", 1, "alpha secret"))).toBe(true);
      expect(save(record("client-b", "b.log", 2, "bravo secret"))).toBe(true);
      expect(save(record("client-c", "c.log", 3, "charlie secret"))).toBe(true);

      expect(database.query(
        "SELECT client_id FROM keylog_archive_files ORDER BY retrieved_at",
      ).all()).toEqual([{ client_id: "client-b" }, { client_id: "client-c" }]);
      expect(database.query(
        "SELECT client_id FROM keylog_archive_fts ORDER BY rowid",
      ).all()).toEqual([{ client_id: "client-b" }, { client_id: "client-c" }]);
      expect((database.query(
        "SELECT COUNT(*) AS count FROM keylog_archive_fts WHERE keylog_archive_fts MATCH 'alpha'",
      ).get() as { count: number }).count).toBe(0);
    } finally {
      database.close();
    }
  });

  test("prunes enough oldest rows to satisfy the aggregate byte cap", () => {
    const { database, save } = createHarness({ ...generousLimits, globalBytes: 10 });
    try {
      expect(save(record("client-a", "a.log", 1, "aaaa"))).toBe(true);
      expect(save(record("client-b", "b.log", 2, "bbbb"))).toBe(true);
      expect(save(record("client-c", "c.log", 3, "ccccccc"))).toBe(true);

      expect(database.query(
        "SELECT client_id, size FROM keylog_archive_files ORDER BY retrieved_at",
      ).all()).toEqual([{ client_id: "client-c", size: 7 }]);
      expect((database.query(
        "SELECT COUNT(*) AS count FROM keylog_archive_fts",
      ).get() as { count: number }).count).toBe(1);
    } finally {
      database.close();
    }
  });

  test("prunes the oldest per-client row even when aggregate capacity remains", () => {
    const { database, save } = createHarness({ ...generousLimits, perClientFiles: 1 });
    try {
      expect(save(record("client-a", "a.log", 1, "alpha"))).toBe(true);
      expect(save(record("client-a", "b.log", 2, "bravo"))).toBe(true);
      expect(save(record("client-b", "c.log", 3, "charlie"))).toBe(true);

      expect(database.query(
        "SELECT client_id, filename FROM keylog_archive_files ORDER BY id",
      ).all()).toEqual([
        { client_id: "client-a", filename: "b.log" },
        { client_id: "client-b", filename: "c.log" },
      ]);
    } finally {
      database.close();
    }
  });

  test("accounts legacy rows by actual UTF-8 content and normalizes a replacement size", () => {
    const { database, save } = createHarness({
      ...generousLimits,
      perClientBytes: 5,
    });
    try {
      database.run(
        `INSERT INTO keylog_archive_files
          (client_id, filename, size, modified_at, retrieved_at, content)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["client-a", "legacy.log", 0, 1, 1, "12345678"],
      );

      expect(save(record("client-a", "legacy.log", 2, "four"))).toBe(true);
      expect(database.query(
        `SELECT size, LENGTH(CAST(content AS BLOB)) AS actualBytes
         FROM keylog_archive_files WHERE client_id='client-a' AND filename='legacy.log'`,
      ).get()).toEqual({ size: 4, actualBytes: 4 });
    } finally {
      database.close();
    }
  });

  test("prunes legacy rows using actual content bytes instead of advertised size", () => {
    const { database, save } = createHarness({
      ...generousLimits,
      globalBytes: 10,
    });
    try {
      database.run(
        `INSERT INTO keylog_archive_files
          (client_id, filename, size, modified_at, retrieved_at, content)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["legacy-client", "legacy.log", 0, 1, 1, "12345678"],
      );

      expect(save(record("new-client", "new.log", 2, "abcdef"))).toBe(true);
      expect(database.query(
        "SELECT client_id, filename, size FROM keylog_archive_files",
      ).all()).toEqual([{ client_id: "new-client", filename: "new.log", size: 6 }]);
    } finally {
      database.close();
    }
  });

  test("converges a legacy per-client overage while protecting its replacement and FTS row", () => {
    const { database, save } = createHarness({
      ...generousLimits,
      perClientFiles: 1,
      globalFiles: 10_000,
    });
    try {
      const insert = database.prepare(
        `INSERT INTO keylog_archive_files
          (client_id, filename, size, modified_at, retrieved_at, content)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const insertFts = database.prepare(
        `INSERT INTO keylog_archive_fts(rowid, file_id, client_id, filename, content)
         VALUES (?, ?, ?, ?, ?)`,
      );
      database.transaction(() => {
        const protectedResult = insert.run(
          "client-a",
          "protected.log",
          0,
          0,
          0,
          "protected old",
        );
        const protectedId = Number(protectedResult.lastInsertRowid);
        insertFts.run(
          protectedId,
          protectedId,
          "client-a",
          "protected.log",
          "protected old",
        );
        for (let i = 0; i < 5_001; i += 1) {
          const result = insert.run("client-a", `${i}.log`, 1, i + 1, i + 1, "x");
          if (i === 0 || i === 5_000) {
            const id = Number(result.lastInsertRowid);
            insertFts.run(id, id, "client-a", `${i}.log`, "x");
          }
        }
      })();

      const replacement = record("client-a", "protected.log", 10_000, "protected new");
      expect(save(replacement)).toBe(false);
      expect(database.query(
        "SELECT filename, content FROM keylog_archive_files ORDER BY retrieved_at",
      ).all()).toEqual([
        { filename: "protected.log", content: "protected old" },
        { filename: "5000.log", content: "x" },
      ]);
      expect(database.query(
        "SELECT filename, content FROM keylog_archive_fts ORDER BY rowid",
      ).all()).toEqual([
        { filename: "protected.log", content: "protected old" },
        { filename: "5000.log", content: "x" },
      ]);

      expect(save(replacement)).toBe(true);
      expect(database.query(
        "SELECT filename, size, content FROM keylog_archive_files",
      ).all()).toEqual([{
        filename: "protected.log",
        size: Buffer.byteLength("protected new", "utf8"),
        content: "protected new",
      }]);
      expect(database.query(
        "SELECT filename, content FROM keylog_archive_fts",
      ).all()).toEqual([{ filename: "protected.log", content: "protected new" }]);
    } finally {
      database.close();
    }
  });

  test("commits one bounded cleanup batch when a legacy overage cannot yet admit the new row", () => {
    const { database, save } = createHarness({
      ...generousLimits,
      perClientFiles: 10_000,
      globalFiles: 1,
    });
    try {
      const insert = database.prepare(
        `INSERT INTO keylog_archive_files
          (client_id, filename, size, modified_at, retrieved_at, content)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const insertFts = database.prepare(
        `INSERT INTO keylog_archive_fts(rowid, file_id, client_id, filename, content)
         VALUES (?, ?, ?, ?, ?)`,
      );
      database.transaction(() => {
        for (let i = 0; i < 5_002; i += 1) {
          const result = insert.run(`legacy-${i}`, `${i}.log`, 1, i, i, "x");
          if (i === 0 || i === 5_001) {
            const id = Number(result.lastInsertRowid);
            insertFts.run(id, id, `legacy-${i}`, `${i}.log`, "x");
          }
        }
      })();

      const incoming = record("new-client", "new.log", 10_000, "new");
      expect(save(incoming)).toBe(false);
      expect(database.query(
        "SELECT client_id FROM keylog_archive_files ORDER BY retrieved_at",
      ).all()).toEqual([{ client_id: "legacy-5000" }, { client_id: "legacy-5001" }]);
      expect(database.query(
        "SELECT client_id FROM keylog_archive_fts",
      ).all()).toEqual([{ client_id: "legacy-5001" }]);

      expect(save(incoming)).toBe(true);
      expect(database.query(
        "SELECT client_id, filename FROM keylog_archive_files",
      ).all()).toEqual([{ client_id: "new-client", filename: "new.log" }]);
      expect((database.query(
        "SELECT COUNT(*) AS count FROM keylog_archive_fts",
      ).get() as { count: number }).count).toBe(1);
    } finally {
      database.close();
    }
  });

  test("rolls back quota pruning and FTS deletion when the replacement write fails", () => {
    const { database, save } = createHarness({ ...generousLimits, globalFiles: 1 });
    try {
      expect(save(record("client-a", "old.log", 1, "old searchable text"))).toBe(true);
      database.exec(`
        CREATE TRIGGER reject_new_archive BEFORE INSERT ON keylog_archive_files
        WHEN new.filename = 'new.log'
        BEGIN
          SELECT RAISE(ABORT, 'injected failure');
        END;
      `);

      expect(() => save(record("client-b", "new.log", 2, "new text"))).toThrow();
      expect(database.query(
        "SELECT client_id, filename FROM keylog_archive_files",
      ).all()).toEqual([{ client_id: "client-a", filename: "old.log" }]);
      expect(database.query(
        "SELECT client_id, filename FROM keylog_archive_fts",
      ).all()).toEqual([{ client_id: "client-a", filename: "old.log" }]);
    } finally {
      database.close();
    }
  });
});
