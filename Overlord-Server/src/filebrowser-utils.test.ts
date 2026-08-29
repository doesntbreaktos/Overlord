import { describe, expect, test } from "bun:test";
// @ts-expect-error Browser assets are intentionally shipped as plain JavaScript.
import { joinRemotePath, normalizeRemotePathForComparison } from "../public/assets/filebrowser-utils.js";

describe("file browser remote upload paths", () => {
  test("joins files to Windows destinations without mixing separators", () => {
    expect(joinRemotePath("C:\\Temp", "tool.exe")).toBe("C:\\Temp\\tool.exe");
    expect(joinRemotePath("C:\\", "tool.exe")).toBe("C:\\tool.exe");
  });

  test("joins files to Unix and normalized destinations", () => {
    expect(joinRemotePath("/tmp", "tool.sh")).toBe("/tmp/tool.sh");
    expect(joinRemotePath("C:/Temp", "tool.exe")).toBe("C:/Temp/tool.exe");
  });

  test("keeps relative root uploads relative", () => {
    expect(joinRemotePath(".", "tool.bin")).toBe("tool.bin");
    expect(joinRemotePath("", "tool.bin")).toBe("tool.bin");
  });
});

describe("file browser path comparison", () => {
  test("normalizes Windows separators, casing, and trailing separators", () => {
    expect(normalizeRemotePathForComparison(" C:\\Users\\This1\\Down\\ "))
      .toBe("c:/users/this1/down");
    expect(normalizeRemotePathForComparison("c:/users/this1/down"))
      .toBe("c:/users/this1/down");
  });

  test("keeps case-sensitive Unix paths distinct", () => {
    expect(normalizeRemotePathForComparison("/Home/This1/Down/"))
      .toBe("/Home/This1/Down");
    expect(normalizeRemotePathForComparison("/home/this1/down"))
      .toBe("/home/this1/down");
  });
});
