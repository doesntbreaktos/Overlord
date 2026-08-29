import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { getConfig, updateRegistrationConfig } from "../../config";
import { handlePageRoutes } from "./page-routes";

const originalRegistration = { ...getConfig().registration };
const deps = {
  PUBLIC_ROOT: path.resolve(import.meta.dir, "../../../public"),
  secureHeaders: (contentType?: string): Record<string, string> =>
    contentType ? { "Content-Type": contentType } : {},
  mimeType: () => "text/html; charset=utf-8",
  requestIP: () => ({ address: "127.0.0.1" }),
};

beforeAll(async () => {
  await updateRegistrationConfig({ mode: "off" });
});

afterAll(async () => {
  await updateRegistrationConfig(originalRegistration);
});

describe("registration page exposure", () => {
  test("returns a generic 404 while registration is disabled", async () => {
    const url = new URL("https://overlord.example/register.html");
    const response = await handlePageRoutes(new Request(url), url, deps);
    expect(response?.status).toBe(404);
    expect(await response?.text()).toBe("Not found");
  });

  test("continues serving the page while registration is enabled", async () => {
    await updateRegistrationConfig({ mode: "open" });
    try {
      const url = new URL("https://overlord.example/register.html");
      const response = await handlePageRoutes(new Request(url), url, deps);
      expect(response?.status).toBe(200);
    } finally {
      await updateRegistrationConfig({ mode: "off" });
    }
  });
});
