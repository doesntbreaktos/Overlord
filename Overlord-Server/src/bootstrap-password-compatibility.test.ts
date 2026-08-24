import { expect, test } from "bun:test";
import { getConfig } from "./config";

test("defaults the bootstrap login to admin/admin when no override is supplied", () => {
  const config = getConfig();
  expect(config.auth.username).toBe("admin");
  expect(config.auth.password).toBe("admin");
  expect(config.auth.passwordIsUserSupplied).toBe(false);
});
