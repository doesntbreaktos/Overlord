import { describe, expect, test } from "bun:test";
import {
  buildSelfSignedOpenSslConfig,
  generateRandomSelfSignedSubject,
} from "./certGenerator";

describe("self-signed certificate profile", () => {
  test("uses randomized neutral subject metadata and minimal default SANs", () => {
    const subject = generateRandomSelfSignedSubject();
    const config = buildSelfSignedOpenSslConfig("panel.example.test", [], subject);
    expect(config).toContain(`C=${subject.country}`);
    expect(config).toContain(`ST=${subject.state}`);
    expect(config).toContain(`L=${subject.locality}`);
    expect(config).toContain(`O=${subject.organization}`);
    expect(config).toContain(`OU=${subject.organizationalUnit}`);
    expect(config).toContain(`CN=${subject.commonName}`);
    expect(config).toContain("DNS.1 = panel.example.test");
    expect(config).toContain("DNS.2 = localhost");
    expect(config).toContain("IP.1 = 127.0.0.1");
    expect(config).toContain("IP.2 = ::1");
    expect(config).not.toContain("Overlord");
    expect(config).not.toContain("*.local");
    expect(subject.commonName).toMatch(/^host-[0-9a-f]{16}\.invalid$/);
  });

  test("generates a different subject identity for each certificate", () => {
    const first = generateRandomSelfSignedSubject();
    const second = generateRandomSelfSignedSubject();
    expect(second).not.toEqual(first);
    expect(first.country).toMatch(/^[A-Z]{2}$/);
    expect(first.organization).toMatch(/^Service-[0-9a-f]{16}$/);
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
    expect(ipConfig).toContain("IP.1 = 192.0.2.20");

    const unsafeConfig = buildSelfSignedOpenSslConfig("safe.test\nO=Overlord");
    expect(unsafeConfig).toContain("DNS.1 = localhost");
    expect(unsafeConfig).not.toContain("Overlord");
  });
});
