import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleAssetsRoutes } from "./assets-routes";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("fingerprinted asset compatibility manifest", () => {
  test("serves a fingerprinted file for an authenticated runtime page's stable reference", async () => {
    const publicRoot = await mkdtemp(path.join(os.tmpdir(), "overlord-asset-route-"));
    tempDirs.push(publicRoot);
    await mkdir(path.join(publicRoot, "assets"));
    await writeFile(path.join(publicRoot, "assets", "nav.012345abcdef.js"), "export default true;");
    await writeFile(path.join(publicRoot, ".asset-manifest.json"), JSON.stringify({
      "/assets/nav.js": "/assets/nav.012345abcdef.js",
    }));

    const url = new URL("https://panel.example/assets/nav.js");
    const response = await handleAssetsRoutes(new Request(url), url, {
      PUBLIC_ROOT: publicRoot,
      secureHeaders: (contentType) => ({ "Content-Type": contentType || "application/octet-stream" }),
      mimeType: () => "text/javascript; charset=utf-8",
    });

    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("export default true;");
    expect(response?.headers.get("Cache-Control")).toBe("no-cache");
  });

  test("does not trust a manifest entry outside the fingerprinted asset namespace", async () => {
    const publicRoot = await mkdtemp(path.join(os.tmpdir(), "overlord-asset-route-"));
    tempDirs.push(publicRoot);
    await mkdir(path.join(publicRoot, "assets"));
    await writeFile(path.join(publicRoot, ".asset-manifest.json"), JSON.stringify({
      "/assets/nav.js": "/assets/../../secret.012345abcdef.js",
    }));

    const url = new URL("https://panel.example/assets/nav.js");
    const response = await handleAssetsRoutes(new Request(url), url, {
      PUBLIC_ROOT: publicRoot,
      secureHeaders: () => ({}),
      mimeType: () => "text/javascript; charset=utf-8",
    });
    expect(response?.status).toBe(404);
  });
});
