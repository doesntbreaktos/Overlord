#!/usr/bin/env bun
/**
 * Give first-party production JS/CSS files a deterministic build fingerprint
 * and rewrite references throughout the public tree.
 *
 * A single digest is used for the complete asset set so references between
 * modules remain cache-safe: changing any input changes every fingerprinted
 * URL. Development builds intentionally keep their stable filenames.
 *
 * Usage: bun run scripts/fingerprint-public-assets.ts [--dir public]
 */
import { createHash } from "node:crypto";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const FINGERPRINT_LENGTH = 12;
const FINGERPRINTED_FILE = /\.[0-9a-f]{12}\.(?:js|css)$/i;
const EXCLUDED_ASSETS = new Set(["custom.css", "notification-sw.js"]);
const REWRITABLE_EXTENSIONS = new Set([".html", ".js", ".css"]);

async function collectFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function toPublicUrl(publicDir: string, filePath: string): string {
  return `/${path.relative(publicDir, filePath).replaceAll(path.sep, "/")}`;
}

function fingerprintedPath(filePath: string, fingerprint: string): string {
  const extension = path.extname(filePath);
  return `${filePath.slice(0, -extension.length)}.${fingerprint}${extension}`;
}

function toModuleRelativePath(fromFile: string, toFile: string): string {
  const relative = path.relative(path.dirname(fromFile), toFile).replaceAll(path.sep, "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

export async function fingerprintPublicAssets(publicDirInput: string): Promise<{
  fingerprint: string;
  renamed: number;
  rewritten: number;
}> {
  const publicDir = path.resolve(publicDirInput);
  const assetsDir = path.join(publicDir, "assets");
  const allFiles = await collectFiles(publicDir);
  const assets = allFiles
    .filter((filePath) => filePath.startsWith(`${assetsDir}${path.sep}`))
    .filter((filePath) => [".js", ".css"].includes(path.extname(filePath).toLowerCase()))
    .filter((filePath) => !EXCLUDED_ASSETS.has(path.relative(assetsDir, filePath).replaceAll(path.sep, "/")))
    .filter((filePath) => !FINGERPRINTED_FILE.test(filePath))
    .sort((a, b) => a.localeCompare(b));

  if (assets.length === 0) {
    throw new Error(`No unfingerprinted JavaScript or CSS assets found in ${assetsDir}`);
  }

  const hash = createHash("sha256");
  for (const filePath of assets) {
    hash.update(toPublicUrl(publicDir, filePath));
    hash.update("\0");
    hash.update(await readFile(filePath));
    hash.update("\0");
  }
  const fingerprint = hash.digest("hex").slice(0, FINGERPRINT_LENGTH);

  const replacements = assets.map((filePath) => {
    const destination = fingerprintedPath(filePath, fingerprint);
    return {
      source: filePath,
      destination,
      oldUrl: toPublicUrl(publicDir, filePath),
      newUrl: toPublicUrl(publicDir, destination),
    };
  });

  let rewritten = 0;
  const textFiles = allFiles.filter((filePath) => REWRITABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  for (const filePath of textFiles) {
    const original = await readFile(filePath, "utf8");
    let updated = original;
    const fileReplacements = replacements.flatMap((replacement) => [
      [replacement.oldUrl, replacement.newUrl] as const,
      [
        toModuleRelativePath(filePath, replacement.source),
        toModuleRelativePath(filePath, replacement.destination),
      ] as const,
    ]).sort(([left], [right]) => right.length - left.length);
    for (const [oldReference, newReference] of fileReplacements) {
      updated = updated.replaceAll(oldReference, newReference);
    }
    if (updated !== original) {
      await writeFile(filePath, updated);
      rewritten++;
    }
  }

  for (const { source, destination } of replacements) {
    await rename(source, destination);
  }

  const manifest = Object.fromEntries(
    replacements.map(({ oldUrl, newUrl }) => [oldUrl, newUrl]),
  );
  await writeFile(
    path.join(publicDir, ".asset-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  return { fingerprint, renamed: replacements.length, rewritten };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dirIndex = args.indexOf("--dir");
  const publicDir = dirIndex !== -1 && args[dirIndex + 1] ? args[dirIndex + 1] : "public";
  const result = await fingerprintPublicAssets(publicDir);
  console.log(
    `Fingerprint ${result.fingerprint}: renamed ${result.renamed} assets and rewrote ${result.rewritten} files.`,
  );
}
