import { afterEach, describe, expect, test } from "bun:test";
import { createHash, X509Certificate } from "crypto";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  computeCertificateSpkiPin,
  getActiveTlsSpkiPins,
  prepareTlsOptions,
} from "./tls-bootstrap";

const originalPins = process.env.OVERLORD_TLS_SPKI_PINS;
const tempRoots: string[] = [];

afterEach(() => {
  if (originalPins === undefined) delete process.env.OVERLORD_TLS_SPKI_PINS;
  else process.env.OVERLORD_TLS_SPKI_PINS = originalPins;
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("TLS identity pin bootstrap", () => {
  test("creates a self-signed certificate and publishes its SPKI pin", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "overlord-tls-pin-"));
    tempRoots.push(root);
    const certPath = path.join(root, "server.crt");
    const keyPath = path.join(root, "server.key");
    const rotationPin = Buffer.alloc(32, 0x42).toString("base64");
    process.env.OVERLORD_TLS_SPKI_PINS =
      `sha256/${rotationPin},invalid,${rotationPin}`;

    const result = await prepareTlsOptions({ certPath, keyPath });
    const certificatePem = readFileSync(certPath, "utf8");
    const certificate = new X509Certificate(certificatePem);
    const expectedPin = createHash("sha256")
      .update(certificate.publicKey.export({ type: "spki", format: "der" }))
      .digest("base64");

    expect(result.source).toBe("self-signed");
    expect(result.tlsOptions.cert).toBe(certificatePem);
    expect(computeCertificateSpkiPin(certificatePem)).toBe(expectedPin);
    expect(getActiveTlsSpkiPins()).toEqual([expectedPin, rotationPin]);
  });

  test("migrates the legacy branded certificate without changing its SPKI pin", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "overlord-tls-legacy-"));
    tempRoots.push(root);
    const certPath = path.join(root, "server.crt");
    const keyPath = path.join(root, "server.key");
    const generated = Bun.spawnSync([
      "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-subj", "/C=US/ST=State/L=City/O=Overlord/OU=IT/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout", keyPath, "-out", certPath, "-days", "30",
    ]);
    expect(generated.exitCode).toBe(0);

    const legacyPem = readFileSync(certPath, "utf8");
    const legacyPin = computeCertificateSpkiPin(legacyPem);
    expect(new X509Certificate(legacyPem).subject).toContain("O=Overlord");

    const result = await prepareTlsOptions({ certPath, keyPath });
    const migratedPem = readFileSync(certPath, "utf8");
    const migratedCertificate = new X509Certificate(migratedPem);
    expect(result.source).toBe("self-signed");
    expect(computeCertificateSpkiPin(migratedPem)).toBe(legacyPin);
    expect(migratedCertificate.subject).not.toContain("Overlord");
    expect(migratedCertificate.subject).toMatch(/O=Service-[0-9a-f]{16}/);
    expect(migratedCertificate.subjectAltName).toContain("DNS:localhost");
  });
});
