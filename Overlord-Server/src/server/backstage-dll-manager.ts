import fs from "fs";
import path from "path";
import { logger } from "../logger";
import { getConfig } from "../config";
import { ensureToolchain, getToolchainRoot } from "./toolchain-manager";
import { resolveRuntimeRoot } from "./runtime-paths";
import {
  BACKSTAGE_DLL_NAME,
  backstageDllOutputPath,
  invalidateBackstageDll,
} from "./backstage-dll-cache";

type SendToStream = (data: { type: "output"; text: string; level?: string }) => void;

const RUST_TARGET = "x86_64-pc-windows-gnu";

export type BackstageDllBuildState = {
  startedAt: number | null;
  finishedAt: number | null;
  ok: boolean | null;
  message: string;
};

export type BackstageDllStatus = {
  configured: { rebuildOnStartup: boolean };
  outputPath: string;
  exists: boolean;
  sizeBytes: number;
  mtimeMs: number;
  exportName: string | null;
  crateDir: string | null;
  toolchainReady: boolean;
  toolchainDetails: {
    cargoOnPath: boolean;
    rustInstalled: boolean;
    rustTargetInstalled: boolean;
    mingwReady: boolean;
  };
  building: boolean;
  lastBuild: BackstageDllBuildState;
};

let _building = false;
let _lastBuild: BackstageDllBuildState = {
  startedAt: null,
  finishedAt: null,
  ok: null,
  message: "No build has been run yet.",
};

function rustToolchainRoot(): string {
  return path.join(getToolchainRoot(), "rust");
}

function cargoBinPath(): string | null {
  const exe = process.platform === "win32" ? "cargo.exe" : "cargo";
  const installed = path.join(rustToolchainRoot(), "cargo", "bin", exe);
  if (fs.existsSync(installed)) return installed;
  return Bun.which("cargo") ? "cargo" : null;
}

function rustlibBaseDir(): string | null {
  const toolchains = path.join(rustToolchainRoot(), "rustup", "toolchains");
  if (!fs.existsSync(toolchains)) return null;
  for (const entry of fs.readdirSync(toolchains)) {
    const lib = path.join(toolchains, entry, "lib");
    if (fs.existsSync(lib)) return lib;
  }
  return null;
}

function mingwGccPath(): string | null {
  const explicit = Bun.which("x86_64-w64-mingw32-gcc");
  if (explicit) return explicit;
  const candidate = path.join(
    getToolchainRoot(),
    "mingw-w64-x64",
    "x86_64-w64-mingw32-cross",
    "bin",
    "x86_64-w64-mingw32-gcc",
  );
  if (fs.existsSync(candidate)) return candidate;
  return null;
}

function toolchainDetails() {
  const installedRustHome = fs.existsSync(path.join(rustToolchainRoot(), "rustup"));
  const rustlib = installedRustHome ? rustlibBaseDir() : null;
  const rustTargetInstalled =
    rustlib !== null && fs.existsSync(path.join(rustlib, "rustlib", RUST_TARGET));
  return {
    cargoOnPath: !!Bun.which("cargo"),
    rustInstalled: cargoBinPath() !== null,
    rustTargetInstalled,
    mingwReady: mingwGccPath() !== null,
  };
}

export function resolveBackstageCrateDir(): string | null {
  const explicit = process.env.BACKSTAGE_CRATE_DIR?.trim();
  if (explicit) return path.resolve(explicit);

  const runtimeRoot = resolveRuntimeRoot();
  const candidates = [
    path.resolve(runtimeRoot, "BackstageInjection-Rust"),
    path.resolve(process.cwd(), "BackstageInjection-Rust"),
    path.resolve(import.meta.dir, "../../../BackstageInjection-Rust"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "Cargo.toml"))) return candidate;
  }
  return null;
}

export function getBackstageDllStatus(): BackstageDllStatus {
  const cfg = getConfig().backstageDll;
  const outputPath = backstageDllOutputPath();
  const details = toolchainDetails();

  let exists = false;
  let sizeBytes = 0;
  let mtimeMs = 0;
  let exportName: string | null = null;
  try {
    const st = fs.statSync(outputPath);
    exists = true;
    sizeBytes = st.size;
    mtimeMs = st.mtimeMs;
    exportName = readPeExportName(outputPath);
  } catch {}

  const toolchainReady =
    process.platform === "win32"
      ? details.cargoOnPath && details.mingwReady
      : details.rustInstalled && details.mingwReady;

  return {
    configured: { rebuildOnStartup: cfg.rebuildOnStartup },
    outputPath,
    exists,
    sizeBytes,
    mtimeMs,
    exportName,
    crateDir: resolveBackstageCrateDir(),
    toolchainReady,
    toolchainDetails: details,
    building: _building,
    lastBuild: { ..._lastBuild },
  };
}

export async function rebuildBackstageDll(
  sendToStream?: SendToStream,
): Promise<{ ok: boolean; message: string }> {
  if (_building) {
    return { ok: false, message: "A Backstage DLL rebuild is already in progress." };
  }

  const send: SendToStream = sendToStream ?? (() => {});
  const crateDir = resolveBackstageCrateDir();
  if (!crateDir) {
    return {
      ok: false,
      message:
        "BackstageInjection-Rust crate not found. Set BACKSTAGE_CRATE_DIR or place the crate next to the server runtime root.",
    };
  }

  _building = true;
  _lastBuild = { startedAt: Date.now(), finishedAt: null, ok: null, message: "Build started." };

  const outPath = backstageDllOutputPath();
  const outDir = path.dirname(outPath);

  try {
    fs.mkdirSync(outDir, { recursive: true });

    const env: Record<string, string> = {};
    const binDirs: string[] = [];

    if (process.platform !== "win32") {
      const rust = await ensureToolchain("rust", send);
      const cargoInInstall = fs.existsSync(
        path.join(rust.rootDir, "cargo", "bin", "cargo"),
      );
      if (cargoInInstall) {
        env.RUSTUP_HOME = path.join(rust.rootDir, "rustup");
        env.CARGO_HOME = path.join(rust.rootDir, "cargo");
      }
      binDirs.push(rust.binDir);

      const mingw = await ensureToolchain("mingw-w64-x64", send);
      binDirs.push(mingw.binDir);
    }

    send({
      type: "output",
      text: `[backstage-dll] rebuilding ${BACKSTAGE_DLL_NAME} from ${crateDir} -> ${outPath}\n`,
      level: "info",
    });
    logger.info(`[backstage-dll] building BackstageInjection DLL (target ${RUST_TARGET})`);

    const fullEnv = pickStringEnv(process.env);
    if (binDirs.length > 0) {
      fullEnv.PATH = [...binDirs, fullEnv.PATH || ""].filter(Boolean).join(path.delimiter);
    }
    Object.assign(fullEnv, env);
    delete fullEnv.BACKSTAGE_LOADER_SEED;

    const streamLines = async (stream: ReadableStream<Uint8Array> | null) => {
      if (!stream) return "";
      let buf = "";
      for await (const chunk of stream) {
        const text = new TextDecoder().decode(chunk);
        buf += text;
        for (const line of text.split("\n")) {
          if (line.trim()) {
            send({ type: "output", text: `[cargo] ${line}\n`, level: "info" });
          }
        }
      }
      return buf;
    };

    const cargoTargetDir = fullEnv.CARGO_TARGET_DIR || path.join(crateDir, "target");
    const built = path.join(cargoTargetDir, RUST_TARGET, "release", "BackstageInjection.dll");
    const buildArtifact = async (loaderEnv: Record<string, string>, destination: string) => {
      const proc = Bun.spawn(
        [
          "cargo",
          "build",
          "--release",
          "--target",
          RUST_TARGET,
          "--manifest-path",
          path.join(crateDir, "Cargo.toml"),
        ],
        { env: { ...fullEnv, ...loaderEnv }, stdout: "pipe", stderr: "pipe" },
      );
      const [stdoutText, stderrText] = await Promise.all([
        streamLines(proc.stdout),
        streamLines(proc.stderr),
      ]);
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const detail = stderrText.trim() || stdoutText.trim() || `cargo exit ${exitCode}`;
        throw new Error(`cargo build failed (exit ${exitCode}): ${detail}`);
      }
      if (!fs.existsSync(built)) {
        throw new Error(`Expected built DLL not found at ${built}`);
      }
      fs.copyFileSync(built, destination);
    };

    await buildArtifact({ BACKSTAGE_LOADER_SEED: String(Date.now()) }, outPath);

    const exportName = readPeExportName(outPath);
    invalidateBackstageDll();

    _lastBuild = {
      startedAt: _lastBuild.startedAt,
      finishedAt: Date.now(),
      ok: true,
      message: `DLL rebuilt: ${BACKSTAGE_DLL_NAME} (${fs.statSync(outPath).size} bytes, export: ${exportName ?? "unknown"}).`,
    };
    send({
      type: "output",
      text: `[backstage-dll] build complete: ${_lastBuild.message}\n`,
      level: "info",
    });
    logger.info(`[backstage-dll] ${_lastBuild.message}`);
    return { ok: true, message: _lastBuild.message };
  } catch (error: any) {
    const message = error?.message || String(error);
    _lastBuild = {
      startedAt: _lastBuild.startedAt,
      finishedAt: Date.now(),
      ok: false,
      message,
    };
    send({ type: "output", text: `[backstage-dll] build failed: ${message}\n`, level: "error" });
    logger.error(`[backstage-dll] rebuild failed: ${message}`);
    return { ok: false, message };
  } finally {
    _building = false;
  }
}

function pickStringEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Minimal PE export-table reader. Scans the names table for the per-build
// randomized `x<hex>` loader export emitted by build.rs.
// ──────────────────────────────────────────────────────────────────────────

const EXPORT_TOKEN_RE = /^x[0-9a-f]{6}$/;

export function readPeExportName(dllPath: string): string | null {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(fs.readFileSync(dllPath));
  } catch {
    return null;
  }
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    // No "MZ" DOS header.
    return null;
  }

  const peOffset = readU32(bytes, 0x3c);
  if (peOffset + 0x18 > bytes.length) return null;
  if (bytes[peOffset] !== 0x50 || bytes[peOffset + 1] !== 0x45) return null; // "PE"

  const coffOffset = peOffset + 4;
  const numberOfSections = readU16(bytes, coffOffset + 2);
  const sizeOfOptionalHeader = readU16(bytes, coffOffset + 16);
  const optOffset = coffOffset + 20;
  if (optOffset + sizeOfOptionalHeader > bytes.length) return null;

  const magic = readU16(bytes, optOffset);
  let ddOffset: number;
  if (magic === 0x20b) {
    ddOffset = optOffset + 112; // PE32+
  } else if (magic === 0x10b) {
    ddOffset = optOffset + 96; // PE32
  } else {
    return null;
  }
  if (ddOffset + 8 > bytes.length) return null;

  const exportRva = readU32(bytes, ddOffset);
  if (exportRva === 0) return null;

  const sectionOffset = optOffset + sizeOfOptionalHeader;
  const sections: Array<{ va: number; vsize: number; rawPtr: number; rawSize: number }> = [];
  for (let i = 0; i < numberOfSections; i++) {
    const base = sectionOffset + i * 40;
    if (base + 40 > bytes.length) break;
    sections.push({
      va: readU32(bytes, base + 12),
      vsize: readU32(bytes, base + 8),
      rawPtr: readU32(bytes, base + 20),
      rawSize: readU32(bytes, base + 16),
    });
  }

  const rvaToOffset = (rva: number): number | null => {
    const headersSize = sectionOffset + numberOfSections * 40;
    if (rva < headersSize) return rva;
    for (const section of sections) {
      const span = Math.max(section.vsize, section.rawSize);
      if (rva >= section.va && rva < section.va + span) {
        return rva - section.va + section.rawPtr;
      }
    }
    return null;
  };

  const exportOffset = rvaToOffset(exportRva);
  if (exportOffset == null || exportOffset + 40 > bytes.length) return null;

  const numberOfNames = readU32(bytes, exportOffset + 24);
  const namesRva = readU32(bytes, exportOffset + 32);
  if (numberOfNames === 0 || namesRva === 0) return null;

  const namesOffset = rvaToOffset(namesRva);
  if (namesOffset == null) return null;

  for (let i = 0; i < numberOfNames; i++) {
    const entryPos = namesOffset + i * 4;
    if (entryPos + 4 > bytes.length) break;
    const nameRva = readU32(bytes, entryPos);
    const nameOffset = rvaToOffset(nameRva);
    if (nameOffset == null) continue;
    let end = nameOffset;
    while (end < bytes.length && bytes[end] !== 0) end++;
    if (end === bytes.length) continue;
    const name = new TextDecoder().decode(bytes.subarray(nameOffset, end));
    if (EXPORT_TOKEN_RE.test(name)) return name;
  }

  return null;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  );
}
