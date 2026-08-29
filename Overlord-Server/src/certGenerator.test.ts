import { describe, expect, test } from "bun:test";
import { buildSelfSignedOpenSslConfig } from "./certGenerator";

describe("self-signed certificate profile", () => {
  test("uses neutral subject metadata and minimal default SANs", () => {
    const config = buildSelfSignedOpenSslConfig("panel.example.test");
    expect(config).toContain("CN=panel.example.test");
    expect(config).toContain("DNS.1 = panel.example.test");
    expect(config).toContain("DNS.2 = localhost");
    expect(config).toContain("IP.1 = 127.0.0.1");
    expect(config).toContain("IP.2 = ::1");
    expect(config).not.toContain("Overlord");
    expect(config).not.toContain("*.local");
    expect(config).not.toMatch(/^O=/m);
    expect(config).not.toMatch(/^OU=/m);
  });

  test("includes only valid explicitly requested interface addresses", () => {
    const config = buildSelfSignedOpenSslConfig("localhost", [
      "192.0.2.10",
      "not-an-ip",
      "192.0.2.10",
    ]);
    expect(config.match(/192\.0\.2\.10/g)).toHaveLength(1);
    expect(config).not.toContain("not-an-ip");
  });

  test("treats an IP common name as an IP SAN and rejects config injection", () => {
    const ipConfig = buildSelfSignedOpenSslConfig("192.0.2.20");
    expect(ipConfig).toContain("CN=192.0.2.20");
    expect(ipConfig).toContain("IP.1 = 192.0.2.20");

    const unsafeConfig = buildSelfSignedOpenSslConfig("safe.test\nO=Overlord");
    expect(unsafeConfig).toContain("CN=localhost");
    expect(unsafeConfig).not.toContain("Overlord");
  });
});
