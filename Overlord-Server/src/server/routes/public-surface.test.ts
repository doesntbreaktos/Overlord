import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateToken } from "../../auth";
import { createUser, deleteUser, getUserById } from "../../users";
import { handleMiscRoutes } from "./misc-routes";

const password = "Aa1!PublicSurface_2026";
let userId = 0;
let token = "";

function depsFor(address: string) {
  return {
    CORS_HEADERS: {},
    SERVER_VERSION: "9.8.7-test",
    PUBLIC_ROOT: ".",
    requestIP: () => ({ address }),
    getConsoleSessionCount: () => 0,
    getRdSessionCount: () => 0,
    getFileBrowserSessionCount: () => 0,
    getProcessSessionCount: () => 0,
  };
}

beforeAll(async () => {
  const created = await createUser(
    `public_surface_${Date.now().toString(36)}`,
    password,
    "admin",
    "test",
  );
  if (!created.success || !created.userId) throw new Error("failed to create test user");
  userId = created.userId;
  token = await generateToken(getUserById(userId)!);
});

afterAll(() => {
  if (userId) deleteUser(userId);
});

describe("public fingerprinting surface", () => {
  test("serves health checks over IPv4 and IPv6 loopback", async () => {
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const url = new URL("https://localhost/health");
      const response = await handleMiscRoutes(new Request(url), url, depsFor(address));
      expect(response?.status).toBe(200);
      expect(await response?.text()).toBe("ok");
      expect(response?.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("hides health checks from non-loopback clients", async () => {
    const url = new URL("https://overlord.example/health");
    const response = await handleMiscRoutes(
      new Request(url),
      url,
      depsFor("203.0.113.10"),
    );
    expect(response?.status).toBe(404);
    expect(await response?.text()).toBe("Not found");
  });

  test("requires authentication for the server version", async () => {
    const url = new URL("https://overlord.example/api/version");
    const response = await handleMiscRoutes(new Request(url), url, depsFor("203.0.113.10"));
    expect(response?.status).toBe(401);
  });

  test("returns the server version to an authenticated operator", async () => {
    const url = new URL("https://overlord.example/api/version");
    const response = await handleMiscRoutes(
      new Request(url, { headers: { Cookie: `overlord_token=${token}` } }),
      url,
      depsFor("203.0.113.10"),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ version: "9.8.7-test" });
    expect(response?.headers.get("cache-control")).toBe("no-store");
  });
});
