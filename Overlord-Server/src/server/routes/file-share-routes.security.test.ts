import { afterEach, describe, expect, test } from "bun:test";
import {
  claimSharedFileDownload,
  deleteSharedFile,
  getSharedFile,
  insertSharedFile,
} from "../../db";
import {
  clearFileSharePasswordAttempts,
  consumeFileSharePasswordAttempt,
  FILE_SHARE_PASSWORD_ATTEMPT_WINDOW_MS,
  FILE_SHARE_PASSWORD_MAX_ATTEMPTS,
  handleFileShareRoutes,
} from "./file-share-routes";

const createdFileIds: string[] = [];

function insertTestFile(options: {
  maxDownloads?: number | null;
  expiresAt?: number | null;
  passwordHash?: string | null;
} = {}): string {
  const id = `file-share-security-${crypto.randomUUID()}`;
  insertSharedFile({
    id,
    filename: "payload.txt",
    storedPath: `${process.env.TEMP || "."}/${id}/payload.txt`,
    size: 7,
    mimeType: "text/plain",
    uploadedBy: 0,
    uploadedByUsername: "test",
    passwordHash: options.passwordHash ?? null,
    maxDownloads: options.maxDownloads ?? null,
    downloadCount: 0,
    expiresAt: options.expiresAt ?? null,
    createdAt: Date.now(),
    description: null,
  });
  createdFileIds.push(id);
  return id;
}

afterEach(() => {
  while (createdFileIds.length > 0) {
    const id = createdFileIds.pop();
    if (id) deleteSharedFile(id);
  }
});

describe("file-share public download security", () => {
  test("password verification attempts are bounded per peer and file", () => {
    const now = 1_000_000;
    const key = `203.0.113.10:${crypto.randomUUID()}`;
    const otherKey = `203.0.113.10:${crypto.randomUUID()}`;
    try {
      for (let i = 0; i < FILE_SHARE_PASSWORD_MAX_ATTEMPTS; i += 1) {
        expect(consumeFileSharePasswordAttempt(key, now).limited).toBe(false);
      }
      const limited = consumeFileSharePasswordAttempt(key, now);
      expect(limited.limited).toBe(true);
      expect(limited.retryAfter).toBe(FILE_SHARE_PASSWORD_ATTEMPT_WINDOW_MS / 1000);
      expect(consumeFileSharePasswordAttempt(otherKey, now).limited).toBe(false);
      expect(
        consumeFileSharePasswordAttempt(key, now + FILE_SHARE_PASSWORD_ATTEMPT_WINDOW_MS).limited,
      ).toBe(false);
    } finally {
      clearFileSharePasswordAttempts(key);
      clearFileSharePasswordAttempts(otherKey);
    }
  });

  test("route rate-limits against the trusted peer address before password verification", async () => {
    const hash = await Bun.password.hash("correct horse battery staple", {
      algorithm: "bcrypt",
      cost: 4,
    });
    const id = insertTestFile({ passwordHash: hash });
    const ip = "198.51.100.44";
    const key = `${ip}:${id}`;
    for (let i = 0; i < FILE_SHARE_PASSWORD_MAX_ATTEMPTS; i += 1) {
      consumeFileSharePasswordAttempt(key);
    }

    try {
      const url = new URL(`https://localhost/api/file-share/${id}/download`);
      const response = await handleFileShareRoutes(
        new Request(url, { headers: { "X-Download-Password": "wrong" } }),
        url,
        {
          FILE_SHARE_ROOT: process.env.TEMP || ".",
          requestIP: () => ({ address: ip }),
        },
      );
      expect(response?.status).toBe(429);
      expect(Number(response?.headers.get("Retry-After"))).toBeGreaterThan(0);
    } finally {
      clearFileSharePasswordAttempts(key);
    }
  });

  test("ignores password query parameters and requires the download header", async () => {
    const hash = await Bun.password.hash("correct horse battery staple", {
      algorithm: "bcrypt",
      cost: 4,
    });
    const id = insertTestFile({ passwordHash: hash });
    const url = new URL(
      `https://localhost/api/file-share/${id}/download?password=${encodeURIComponent("correct horse battery staple")}`,
    );
    const deps = {
      FILE_SHARE_ROOT: process.env.TEMP || ".",
      requestIP: () => ({ address: "198.51.100.45" }),
    };

    const rejected = await handleFileShareRoutes(new Request(url), url, deps);
    expect(rejected?.status).toBe(401);
    expect(await rejected?.json()).toEqual({
      error: "Password required",
    });

    const accepted = await handleFileShareRoutes(
      new Request(url, {
        headers: { "X-Download-Password": "correct horse battery staple" },
      }),
      url,
      deps,
    );
    expect(accepted?.status).toBe(404);
    expect(await accepted?.json()).toEqual({ error: "File not found on disk" });
  });

  test("atomically refuses downloads beyond the configured maximum", () => {
    const id = insertTestFile({ maxDownloads: 1 });
    expect(claimSharedFileDownload(id)).toBe(true);
    expect(claimSharedFileDownload(id)).toBe(false);
    expect(getSharedFile(id)?.downloadCount).toBe(1);
  });

  test("does not claim an expired download", () => {
    const id = insertTestFile({ expiresAt: Date.now() - 1 });
    expect(claimSharedFileDownload(id)).toBe(false);
    expect(getSharedFile(id)?.downloadCount).toBe(0);
  });
});
