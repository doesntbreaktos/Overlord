import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fingerprintPublicAssets } from "./fingerprint-public-assets";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "overlord-assets-"));
  tempDirs.push(root);
  await mkdir(path.join(root, "assets", "generated"), { recursive: true });
  await writeFile(path.join(root, "index.html"), '<script src="/assets/main.js"></script><link href="/assets/ui.css">');
  await writeFile(path.join(root, "assets", "main.js"), 'import("./generated/settings.js");');
  await writeFile(path.join(root, "assets", "ui.css"), "body{color:black}");
  await writeFile(path.join(root, "assets", "generated", "settings.js"), "export default true;");
  await writeFile(path.join(root, "assets", "custom.css"), "/* runtime route */");
  await writeFile(path.join(root, "assets", "notification-sw.js"), 'importScripts("/assets/main.js");');
  return root;
}

describe("production asset fingerprinting", () => {
  test("renames first-party JS/CSS and rewrites HTML and module references", async () => {
    const root = await fixture();
    const result = await fingerprintPublicAssets(root);
    expect(result.renamed).toBe(3);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{12}$/);

    const assetNames = await readdir(path.join(root, "assets"));
    expect(assetNames).toContain(`main.${result.fingerprint}.js`);
    expect(assetNames).toContain(`ui.${result.fingerprint}.css`);
    expect(assetNames).toContain("custom.css");
    expect(assetNames).toContain("notification-sw.js");
    expect(assetNames).not.toContain("main.js");

    expect(await readFile(path.join(root, "index.html"), "utf8"))
      .toContain(`/assets/main.${result.fingerprint}.js`);
    expect(await readFile(path.join(root, "assets", `main.${result.fingerprint}.js`), "utf8"))
      .toContain(`./generated/settings.${result.fingerprint}.js`);
    expect(await readFile(path.join(root, "assets", "notification-sw.js"), "utf8"))
      .toContain(`/assets/main.${result.fingerprint}.js`);
    const manifest = JSON.parse(await readFile(path.join(root, ".asset-manifest.json"), "utf8"));
    expect(manifest["/assets/main.js"]).toBe(`/assets/main.${result.fingerprint}.js`);
    expect(manifest["/assets/custom.css"]).toBeUndefined();
  });

  test("produces the same fingerprint for identical input", async () => {
    const first = await fixture();
    const second = await fixture();
    expect((await fingerprintPublicAssets(first)).fingerprint)
      .toBe((await fingerprintPublicAssets(second)).fingerprint);
  });
});
