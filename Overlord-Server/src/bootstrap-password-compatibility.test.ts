import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureGeneratedBootstrapPassword, getConfig } from "./config";
import { getUserByUsername, updateUserPassword } from "./users";

function readSavedSecrets(): any {
  const savePath = resolve(process.env.DATA_DIR || "./data", "save.json");
  return JSON.parse(readFileSync(savePath, "utf8"));
}

test("generates and persists a one-time bootstrap password when no override is supplied", () => {
  ensureGeneratedBootstrapPassword();
  const config = getConfig();
  expect(config.auth.username).toBe("admin");
  expect(config.auth.password).not.toBe("admin");
  expect(config.auth.password.length).toBeGreaterThanOrEqual(32);
  expect(config.auth.passwordIsUserSupplied).toBe(false);

  const saved = readSavedSecrets();
  expect(saved.auth.bootstrapPassword).toBe(config.auth.password);
});

test("removes the persisted bootstrap password after the initial account rotates it", async () => {
  const config = getConfig();
  const initialAdmin = getUserByUsername(config.auth.username);
  expect(initialAdmin?.created_by).toBe("system");
  expect(initialAdmin?.must_change_password).toBe(1);

  const result = await updateUserPassword(
    initialAdmin!.id,
    "Aa1!RotatedBootstrapPassword_2026",
  );
  expect(result.success).toBe(true);
  expect(readSavedSecrets().auth.bootstrapPassword).toBeUndefined();
  expect(getConfig().auth.password).toBe("");
});
