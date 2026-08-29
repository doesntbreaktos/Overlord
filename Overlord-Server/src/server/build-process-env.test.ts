import { describe, expect, test } from "bun:test";
import path from "path";
import { createIsolatedBuildEnv, createIsolatedGoBuildEnv } from "./build-environment";

describe("builder environment isolation", () => {
  test("drops ambient and .env-derived values", () => {
    const env = createIsolatedBuildEnv({
      PATH: "/toolchain/bin",
      HOME: "/builder",
      TEMP: "/tmp",
      JWT_SECRET: "must-not-leak",
      OVERLORD_AGENT_TOKEN: "must-not-leak",
      CUSTOM_BUILD_FLAG: "must-not-leak",
      GOFLAGS: "must-not-affect-build",
    });

    expect(env).toEqual({
      PATH: "/toolchain/bin",
      HOME: "/builder",
      TEMP: "/tmp",
    });
  });

  test("places Go and Garble writable caches under the build cache root", () => {
    const cacheRoot = path.resolve("build-cache");
    const env = createIsolatedGoBuildEnv(cacheRoot, {
      PATH: "/toolchain/bin",
      HOME: "/home/bun",
      GOTMPDIR: "/tmp/ambient-go-tmp",
      GARBLE_CACHE: "/tmp/ambient-garble",
      JWT_SECRET: "must-not-leak",
    });

    expect(env).toEqual({
      PATH: "/toolchain/bin",
      HOME: "/home/bun",
      GOCACHE: path.join(cacheRoot, "go-build"),
      GOMODCACHE: path.join(cacheRoot, "go-mod"),
      GOTMPDIR: path.join(cacheRoot, "go-tmp"),
      GARBLE_CACHE: path.join(cacheRoot, "garble"),
    });
  });
});
