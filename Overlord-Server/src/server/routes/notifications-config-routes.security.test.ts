import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateToken } from "../../auth";
import {
  createUser,
  deleteUser,
  getUserById,
  getUserNotificationSettings,
} from "../../users";
import { handleNotificationsConfigRoutes } from "./notifications-config-routes";

let adminUserId = 0;
let adminToken = "";

const server = {
  requestIP: () => ({ address: "127.0.0.1" }),
};

const deps = {
  getNotificationScreenshot: () => null,
  secureHeaders: () => ({}),
};

beforeAll(async () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const created = await createUser(
    `nsa_${suffix}`,
    "Aa1!NotificationsSecurityPass_2026",
    "admin",
    "test",
  );
  expect(created.success).toBe(true);
  adminUserId = created.userId!;
  adminToken = await generateToken(getUserById(adminUserId)!);
});

afterAll(() => {
  if (adminUserId) deleteUser(adminUserId);
});

function authenticatedJsonRequest(
  url: URL,
  method: string,
  body: string,
  declaredLength?: number,
): Request {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${adminToken}`,
    "Content-Type": "application/json",
  };
  if (declaredLength !== undefined) headers["Content-Length"] = String(declaredLength);
  return new Request(url, { method, headers, body });
}

describe("notification configuration request limits", () => {
  test("rejects oversized bodies at every authenticated mutation endpoint", async () => {
    const cases = [
      { path: "/api/notifications/config", method: "PUT", bytes: 128 * 1024 + 1 },
      { path: "/api/notifications/my-settings", method: "PUT", bytes: 64 * 1024 + 1 },
      { path: "/api/notifications/my-settings/preview/webhook", method: "POST", bytes: 32 * 1024 + 1 },
      { path: "/api/notifications/push-subscribe", method: "POST", bytes: 16 * 1024 + 1 },
      { path: "/api/notifications/push-subscribe", method: "DELETE", bytes: 16 * 1024 + 1 },
    ];

    for (const entry of cases) {
      const url = new URL(`https://localhost${entry.path}`);
      const response = await handleNotificationsConfigRoutes(
        authenticatedJsonRequest(url, entry.method, "{}", entry.bytes),
        url,
        server,
        deps,
      );
      expect(response?.status).toBe(413);
      expect(await response!.json()).toEqual({ error: "Request body too large" });
    }
  });

  test("rejects oversized global Telegram credentials before persisting them", async () => {
    for (const body of [
      { telegramBotToken: "t".repeat(513) },
      { telegramChatId: "c".repeat(257) },
    ]) {
      const url = new URL("https://localhost/api/notifications/config");
      const response = await handleNotificationsConfigRoutes(
        authenticatedJsonRequest(url, "PUT", JSON.stringify(body)),
        url,
        server,
        deps,
      );
      expect(response?.status).toBe(400);
      expect((await response!.json()).error).toContain("too long");
    }
  });

  test("accepts per-user Telegram credentials at the limit and rejects larger replacements", async () => {
    const url = new URL("https://localhost/api/notifications/my-settings");
    const token = "t".repeat(512);
    const chatId = "c".repeat(256);
    const accepted = await handleNotificationsConfigRoutes(
      authenticatedJsonRequest(
        url,
        "PUT",
        JSON.stringify({ telegram_bot_token: token, telegram_chat_id: chatId }),
      ),
      url,
      server,
      deps,
    );
    expect(accepted?.status).toBe(200);
    expect(getUserNotificationSettings(adminUserId)?.telegram_bot_token).toBe(token);
    expect(getUserNotificationSettings(adminUserId)?.telegram_chat_id).toBe(chatId);

    for (const body of [
      { telegram_bot_token: `${token}x` },
      { telegram_chat_id: `${chatId}x` },
    ]) {
      const rejected = await handleNotificationsConfigRoutes(
        authenticatedJsonRequest(url, "PUT", JSON.stringify(body)),
        url,
        server,
        deps,
      );
      expect(rejected?.status).toBe(400);
      expect((await rejected!.json()).error).toContain("too long");
    }

    expect(getUserNotificationSettings(adminUserId)?.telegram_bot_token).toBe(token);
    expect(getUserNotificationSettings(adminUserId)?.telegram_chat_id).toBe(chatId);
  });
});
