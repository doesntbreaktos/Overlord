import { describe, expect, test } from "bun:test";
import { enforceBuilderReleaseTag } from "./build-process";

describe("UI agent build policy", () => {
  test("adds builder_release to every build tag set", () => {
    expect(enforceBuilderReleaseTag([])).toEqual(["builder_release"]);
    expect(enforceBuilderReleaseTag(["noprint", "persist_startup"])).toEqual([
      "builder_release",
      "noprint",
      "persist_startup",
    ]);
  });

  test("does not duplicate builder_release", () => {
    expect(enforceBuilderReleaseTag(["builder_release", "noprint"])).toEqual([
      "builder_release",
      "noprint",
    ]);
  });
});
