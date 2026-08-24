import { describe, expect, test } from "bun:test";
import {
  dispatchGeneratedWebPushRequest,
  sendWebPush,
  webPushResultForStatus,
} from "./web-push";

describe("web push transport security", () => {
  test("routes generated request details through the pinned public HTTP transport", async () => {
    const body = Buffer.from([1, 2, 3, 4]);
    const calls: Array<{ url: string; init: RequestInit }> = [];

    const response = await dispatchGeneratedWebPushRequest(
      {
        endpoint: "https://push.example.test/subscription/abc",
        method: "POST",
        headers: { TTL: 3600, Authorization: "vapid token" },
        body,
      },
      async (url, init = {}) => {
        calls.push({ url, init });
        return new Response(null, { status: 201 });
      },
    );

    const observed = calls[0];
    expect(response.status).toBe(201);
    expect(observed.url).toBe("https://push.example.test/subscription/abc");
    expect(observed.init.method).toBe("POST");
    expect(new Headers(observed.init.headers).get("authorization")).toBe("vapid token");
    expect(new Headers(observed.init.headers).get("ttl")).toBe("3600");
    expect(new Uint8Array(await new Response(observed.init.body).arrayBuffer())).toEqual(
      new Uint8Array(body),
    );
  });

  test("rejects non-HTTPS generated endpoints before invoking transport", async () => {
    let invoked = false;
    await expect(
      dispatchGeneratedWebPushRequest(
        {
          endpoint: "http://push.example.test/subscription/abc",
          method: "POST",
          headers: {},
          body: null,
        },
        async () => {
          invoked = true;
          return new Response(null, { status: 201 });
        },
      ),
    ).rejects.toThrow("must use HTTPS");
    expect(invoked).toBe(false);
  });

  test("rejects credentialed generated endpoints before invoking transport", async () => {
    let invoked = false;
    await expect(
      dispatchGeneratedWebPushRequest(
        {
          endpoint: "https://user:pass@push.example.test/subscription/abc",
          method: "POST",
          headers: {},
          body: null,
        },
        async () => {
          invoked = true;
          return new Response(null, { status: 201 });
        },
      ),
    ).rejects.toThrow("embedded credentials");
    expect(invoked).toBe(false);
  });

  test("rejects private literal endpoints in the real pinned transport", async () => {
    await expect(
      dispatchGeneratedWebPushRequest({
        endpoint: "https://127.0.0.1:8443/push",
        method: "POST",
        headers: {},
        body: null,
      }),
    ).rejects.toThrow("private/internal");
  });

  test("preserves success and expired-subscription status semantics", () => {
    expect(webPushResultForStatus(201)).toEqual({ success: true });
    expect(webPushResultForStatus(404)).toEqual({
      success: false,
      gone: true,
      error: "subscription gone (404)",
    });
    expect(webPushResultForStatus(410)).toEqual({
      success: false,
      gone: true,
      error: "subscription gone (410)",
    });
    expect(webPushResultForStatus(500)).toEqual({
      success: false,
      error: "Received unexpected response code",
    });
  });

  test("preserves the public HTTPS requirement before loading push keys", async () => {
    const result = await sendWebPush(
      {
        endpoint: "http://93.184.216.34/push",
        keys: { p256dh: "unused", auth: "unused" },
      },
      "payload",
    );

    expect(result).toEqual({ success: false, error: "push endpoint must use HTTPS" });
  });
});
