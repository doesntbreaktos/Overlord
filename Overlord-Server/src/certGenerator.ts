import { spawn } from "child_process";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import { dirname } from "path";
import { isIP } from "node:net";

interface CertOptions {
  certPath: string;
  keyPath: string;
  commonName?: string;
  daysValid?: number;
  additionalIPs?: string[];
}

function safeCertificateName(value: string | undefined): string {
  const candidate = String(value || "").trim();
  if (isIP(candidate)) return candidate;
  if (
    candidate.length > 0 &&
    candidate.length <= 253 &&
    /^(?:\*\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(candidate)
  ) {
    return candidate;
  }
  return "localhost";
}

export function buildSelfSignedOpenSslConfig(
  commonNameInput = "localhost",
  additionalIPs: string[] = [],
): string {
  const commonName = safeCertificateName(commonNameInput);
  const dnsNames = isIP(commonName)
    ? ["localhost"]
    : Array.from(new Set([commonName, "localhost"]));
  const ipNames = Array.from(new Set([
    ...(isIP(commonName) ? [commonName] : []),
    "127.0.0.1",
    "::1",
    ...additionalIPs.filter((ip) => isIP(ip)),
  ]));
  const altNames = [
    ...dnsNames.map((name, index) => `DNS.${index + 1} = ${name}`),
    ...ipNames.map((ip, index) => `IP.${index + 1} = ${ip}`),
  ].join("\n");

  return `
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = req_ext
x509_extensions = v3_ca

[dn]
CN=${commonName}

[req_ext]
subjectAltName = @alt_names

[v3_ca]
subjectAltName = @alt_names
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
${altNames}
`;
}

export function certificatesExist(certPath: string, keyPath: string): boolean {
  return existsSync(certPath) && existsSync(keyPath);
}

export async function generateSelfSignedCert(
  options: CertOptions,
): Promise<void> {
  const {
    certPath,
    keyPath,
    commonName: commonNameInput = "localhost",
    daysValid = 825,
    additionalIPs = [],
  } = options;
  const commonName = safeCertificateName(commonNameInput);

  const certDir = dirname(certPath);
  if (!existsSync(certDir)) {
    mkdirSync(certDir, { recursive: true });
  }

  console.log("[TLS] Generating self-signed certificate...");
  console.log(`[TLS] Common Name: ${commonName}`);
  console.log(`[TLS] Valid for: ${daysValid} days`);

  const sanConfig = buildSelfSignedOpenSslConfig(commonName, additionalIPs);

  const configPath = `${certDir}/openssl.cnf`;

  try {
    await Bun.write(configPath, sanConfig);

    await execCommand("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      daysValid.toString(),
      "-config",
      configPath,
    ]);

    try {
      unlinkSync(configPath);
    } catch {}

    console.log(`[TLS] ✓ Certificate generated successfully`);
    console.log(`[TLS]   Certificate: ${certPath}`);
    console.log(`[TLS]   Private Key: ${keyPath}`);
  } catch (error) {
    console.error("[TLS] Failed to generate certificate:", error);
    throw new Error(`Certificate generation failed: ${error}`);
  }
}

function execCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Command failed with code ${code}: ${stderr}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to execute ${command}: ${err.message}`));
    });
  });
}

export async function isOpenSSLAvailable(): Promise<boolean> {
  try {
    await execCommand("openssl", ["version"]);
    return true;
  } catch {
    return false;
  }
}

export function getLocalIPs(): string[] {
  try {
    const os = require("os");
    const interfaces = os.networkInterfaces();
    const ips: string[] = [];

    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) {
          ips.push(iface.address);
        }
      }
    }

    return ips;
  } catch {
    return [];
  }
}
