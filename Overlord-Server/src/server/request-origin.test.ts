import { describe, expect, test } from "bun:test";
import { isSameOriginBrowserRequest } from "./request-origin";

describe("browser request origin validation", () => {
  const url = new URL("https://overlord.example.com/api/dashboard/ws");

  test("accepts the exact origin", () => {
    const req = new Request(url, {
      headers: { Origin: "https://overlord.example.com", "Sec-Fetch-Site": "same-origin" },
    });
    expect(isSameOriginBrowserRequest(req, url, { requireOrigin: true })).toBe(true);
  });

  test("rejects sibling, null, malformed, and missing viewer origins", () => {
    for (const origin of ["https://evil.example.com", "null", "not a url"]) {
      const req = new Request(url, { headers: { Origin: origin } });
      expect(isSameOriginBrowserRequest(req, url, { requireOrigin: true })).toBe(false);
    }
    expect(isSameOriginBrowserRequest(new Request(url), url, { requireOrigin: true })).toBe(false);
  });

  test("rejects browser-declared same-site requests even without Origin", () => {
    const req = new Request(url, { headers: { "Sec-Fetch-Site": "same-site" } });
    expect(isSameOriginBrowserRequest(req, url)).toBe(false);
  });
});
