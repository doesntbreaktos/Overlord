import { describe, expect, test } from "bun:test";
import { readJsonBodyLimited, RequestBodyTooLargeError } from "./request-body";

describe("readJsonBodyLimited", () => {
  test("parses a bounded JSON request", async () => {
    const request = new Request("https://localhost/api/login", {
      method: "POST",
      body: JSON.stringify({ user: "alice" }),
    });
    expect(await readJsonBodyLimited(request, 1_024)).toEqual({ user: "alice" });
  });

  test("rejects declared and streamed bodies over the limit", async () => {
    const declared = new Request("https://localhost/api/login", {
      method: "POST",
      headers: { "Content-Length": "100" },
      body: "{}",
    });
    await expect(readJsonBodyLimited(declared, 10)).rejects.toBeInstanceOf(RequestBodyTooLargeError);

    const streamed = new Request("https://localhost/api/login", {
      method: "POST",
      body: "x".repeat(100),
    });
    await expect(readJsonBodyLimited(streamed, 10)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });
});
