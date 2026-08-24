import { beforeEach, describe, expect, test } from "bun:test";
import { clearRequestRateLimitsForTests } from "../rateLimit";
import {
  createHttpFetchHandler,
  MAX_HTTP_METRIC_ROUTE_LENGTH,
  normalizeHttpRoute,
} from "./http-dispatch";

const metrics = {
  withHttpMetrics: (fn: () => Promise<Response>) => fn(),
};

function makeServer(ip: string) {
  return {
    requestIP: () => ({ address: ip }),
    upgrade: () => false,
  };
}

beforeEach(() => {
  clearRequestRateLimitsForTests();
});

describe("createHttpFetchHandler rate limiting", () => {
  test("throttles repeated unauthorized responses from the same IP", async () => {
    const handler = createHttpFetchHandler({
      metrics,
      CORS_HEADERS: {},
      routes: [async () => new Response("Unauthorized", { status: 401 })],
    });

    for (let i = 0; i < 120; i += 1) {
      const res = await handler(new Request("https://localhost/api/private"), makeServer("203.0.113.10"));
      expect(res.status).toBe(401);
    }

    const limited = await handler(new Request("https://localhost/api/private"), makeServer("203.0.113.10"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("createHttpFetchHandler browser origin checks", () => {
  const makeHandler = () => createHttpFetchHandler({
    metrics,
    CORS_HEADERS: {},
    routes: [async () => new Response("ok")],
  });

  test("rejects an unsafe request from a sibling origin", async () => {
    const response = await makeHandler()(
      new Request("https://overlord.example.com/api/enrollment/client/approve", {
        method: "POST",
        headers: {
          Origin: "https://evil.example.com",
          "Sec-Fetch-Site": "same-site",
        },
      }),
      makeServer("203.0.113.10"),
    );
    expect(response.status).toBe(403);
  });

  test("allows same-origin browser and headerless native requests", async () => {
    const browserResponse = await makeHandler()(
      new Request("https://overlord.example.com/api/action", {
        method: "POST",
        headers: {
          Origin: "https://overlord.example.com",
          "Sec-Fetch-Site": "same-origin",
        },
      }),
      makeServer("203.0.113.10"),
    );
    expect(browserResponse.status).toBe(200);

    const nativeResponse = await makeHandler()(
      new Request("https://overlord.example.com/api/action", { method: "POST" }),
      makeServer("203.0.113.10"),
    );
    expect(nativeResponse.status).toBe(200);
  });
});

describe("normalizeHttpRoute", () => {
  test("collapses dynamic route segments", () => {
    const req = new Request(
      "https://localhost/api/clients/0a44a8d4d61c7840540b43fd187fe3c43e2c46c9600b2aa1a61a6b1ab03c5b92/rd/ws?cache=1",
      { method: "POST" },
    );

    expect(normalizeHttpRoute(req, new URL(req.url))).toBe(
      "POST /api/clients/:id/rd/ws",
    );
  });

  test("groups static asset files", () => {
    const req = new Request("https://localhost/assets/metrics.js");

    expect(normalizeHttpRoute(req, new URL(req.url))).toBe("GET /assets/:file");
  });

  test("bounds adversarial route labels retained by metrics", () => {
    const req = new Request(`https://localhost/${"!".repeat(8_000)}`);
    expect(normalizeHttpRoute(req, new URL(req.url)).length).toBe(
      MAX_HTTP_METRIC_ROUTE_LENGTH,
    );
  });
});
