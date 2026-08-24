import { describe, expect, test } from "bun:test";
import { getConfig, updateRegistrationConfig } from "../../config";
import { handleRegistrationRoutes } from "./registration-routes";

describe("public registration body limits", () => {
  test("rejects an oversized body before JSON buffering", async () => {
    const original = { ...getConfig().registration };
    await updateRegistrationConfig({ mode: "open" });
    try {
      const url = new URL("https://localhost/api/register");
      const response = await handleRegistrationRoutes(
        new Request(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(16 * 1024 + 1),
          },
          body: "{}",
        }),
        url,
        { requestIP: () => ({ address: `198.51.100.${Math.floor(Math.random() * 200) + 1}` }) },
      );

      expect(response?.status).toBe(413);
      expect(await response!.json()).toMatchObject({ error: "Request body too large" });
    } finally {
      await updateRegistrationConfig(original);
    }
  });
});
