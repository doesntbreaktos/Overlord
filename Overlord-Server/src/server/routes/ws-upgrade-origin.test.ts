import { describe, expect, test } from "bun:test";
import { handleWsUpgradeRoutes, normalizeClaimedClientId } from "./ws-upgrade-routes";

function makeServer(ip: string) {
  let upgraded = false;
  return {
    requestIP: () => ({ address: ip }),
    upgrade: () => {
      upgraded = true;
      return true;
    },
    wasUpgraded: () => upgraded,
  };
}

describe("WebSocket browser origin boundary", () => {
  test("bounds and sanitizes the untrusted agent ID path segment", () => {
    expect(normalizeClaimedClientId("normal-client_1", () => "fallback")).toBe("normal-client_1");
    expect(normalizeClaimedClientId("..%2Funsafe", () => "fallback")).toBe("fallback");
    expect(normalizeClaimedClientId("x".repeat(129), () => "fallback")).toBe("fallback");
    expect(normalizeClaimedClientId("%E0%A4%A", () => "fallback")).toBe("fallback");
  });

  test("rejects sibling and missing origins on viewer sockets", async () => {
    const cases: HeadersInit[] = [
      { Origin: "https://evil.example.com", "Sec-Fetch-Site": "same-site" },
      {},
    ];
    for (const headers of cases) {
      const req = new Request("https://overlord.example.com/api/dashboard/ws", { headers });
      const server = makeServer(`198.51.100.${Math.floor(Math.random() * 100 + 1)}`);
      const response = await handleWsUpgradeRoutes(req, new URL(req.url), server, {
        isAuthorizedAgentRequest: () => false,
      });
      expect(response?.status).toBe(403);
      expect(server.wasUpgraded()).toBe(false);
    }
  });

  test("allows native agent upgrades without an Origin header", async () => {
    const req = new Request("https://overlord.example.com/api/clients/native-agent/stream/ws");
    const server = makeServer("198.51.100.201");
    const response = await handleWsUpgradeRoutes(req, new URL(req.url), server, {
      isAuthorizedAgentRequest: () => true,
    });
    expect(response?.status).toBe(200);
    expect(server.wasUpgraded()).toBe(true);
  });

  test("same-origin viewer request reaches authentication", async () => {
    const req = new Request("https://overlord.example.com/api/dashboard/ws", {
      headers: { Origin: "https://overlord.example.com", "Sec-Fetch-Site": "same-origin" },
    });
    const server = makeServer("198.51.100.202");
    const response = await handleWsUpgradeRoutes(req, new URL(req.url), server, {
      isAuthorizedAgentRequest: () => false,
    });
    expect(response?.status).toBe(401);
    expect(server.wasUpgraded()).toBe(false);
  });
});
