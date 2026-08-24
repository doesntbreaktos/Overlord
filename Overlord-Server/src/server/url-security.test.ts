import { describe, expect, test } from "bun:test";
import {
  createSafeUpstreamResponse,
  isPrivateOrLocalAddress,
  validatePublicHttpUrl,
} from "./url-security";

describe("isPrivateOrLocalAddress", () => {
  test("flags local and private IPv4 ranges", () => {
    expect(isPrivateOrLocalAddress("127.0.0.1")).toBe(true);
    expect(isPrivateOrLocalAddress("10.1.2.3")).toBe(true);
    expect(isPrivateOrLocalAddress("172.16.0.1")).toBe(true);
    expect(isPrivateOrLocalAddress("192.168.1.1")).toBe(true);
    expect(isPrivateOrLocalAddress("169.254.169.254")).toBe(true);
  });

  test("flags local and private IPv6 ranges", () => {
    expect(isPrivateOrLocalAddress("::1")).toBe(true);
    expect(isPrivateOrLocalAddress("fe80::1")).toBe(true);
    expect(isPrivateOrLocalAddress("fd00::1")).toBe(true);
    expect(isPrivateOrLocalAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrLocalAddress("::ffff:7f00:1")).toBe(true);
    expect(isPrivateOrLocalAddress("fe9f::1")).toBe(true);
    expect(isPrivateOrLocalAddress("ff02::1")).toBe(true);
  });

  test("allows public addresses", () => {
    expect(isPrivateOrLocalAddress("8.8.8.8")).toBe(false);
    expect(isPrivateOrLocalAddress("2001:4860:4860::8888")).toBe(false);
  });
});

describe("validatePublicHttpUrl", () => {
  test("rejects localhost and credentialed URLs", async () => {
    await expect(validatePublicHttpUrl("http://localhost/file.bin")).rejects.toThrow();
    await expect(validatePublicHttpUrl("https://user:pass@example.com/file.bin")).rejects.toThrow();
  });

  test("rejects hostnames that resolve to private addresses", async () => {
    await expect(
      validatePublicHttpUrl("https://example.test/file.bin", async () => [{ address: "10.0.0.5" }]),
    ).rejects.toThrow("private/internal");
    await expect(
      validatePublicHttpUrl(
        "https://example.test/file.bin",
        async () => [{ address: "93.184.216.34" }, { address: "127.0.0.1" }],
      ),
    ).rejects.toThrow("private/internal");
  });

  test("allows hostnames that resolve to public addresses", async () => {
    const parsed = await validatePublicHttpUrl(
      "https://example.test/file.bin",
      async () => [{ address: "93.184.216.34" }],
    );
    expect(parsed.hostname).toBe("example.test");
  });
});

describe("createSafeUpstreamResponse", () => {
  test("normalizes non-Fetch HTTP status codes instead of throwing", async () => {
    const response = createSafeUpstreamResponse(
      new TextEncoder().encode("upstream body"),
      999,
      "Odd upstream status",
      ["Content-Type", "text/plain"],
    );
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("upstream body");
  });

  test("drops bodies for statuses that forbid a Fetch response body", async () => {
    const response = createSafeUpstreamResponse(
      new TextEncoder().encode("invalid body"),
      204,
      "No Content",
      [],
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });
});
