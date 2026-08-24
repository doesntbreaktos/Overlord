import { describe, expect, test } from "bun:test";
import { encode } from "@msgpack/msgpack";
import {
  buildViewerFrameBuffer,
  decodeViewerPayload,
  MAX_VIEWER_AUDIO_CHUNK_BYTES,
  MAX_VIEWER_BUFFERED_BYTES,
  MAX_VIEWER_MESSAGE_BYTES,
  safeSendViewer,
  safeSendViewerBytes,
} from "./ws-viewer-utils";

describe("viewer inbound MessagePack limits", () => {
  test("decodes normal payloads and rejects allocation-amplifying containers", () => {
    expect(decodeViewerPayload(encode({ type: "input", x: 10 }))).toEqual({
      type: "input",
      x: 10,
    });
    expect(decodeViewerPayload(new Uint8Array([0xdd, 0xff, 0xff, 0xff, 0xff])))
      .toBeNull();
  });
});

describe("viewer frame protocol", () => {
  test("encodes HEVC as compact frame format 5", () => {
    const payload = new Uint8Array([0, 0, 0, 1, 0x40]);
    const frame = buildViewerFrameBuffer(payload, {
      format: "hevc",
      monitor: 2,
      fps: 60,
      width: 1920,
      height: 1080,
    });

    expect(frame[3]).toBe(2);
    expect(frame[4]).toBe(2);
    expect(frame[5]).toBe(60);
    expect(frame[6]).toBe(5);
    expect(frame.slice(12)).toEqual(payload);
  });
});

describe("viewer outbound limits", () => {
  function mockViewer(buffered = 0) {
    const sent: unknown[] = [];
    return {
      sent,
      socket: {
        data: {},
        getBufferedAmount: () => buffered,
        send: (value: unknown) => { sent.push(value); },
      } as any,
    };
  }

  test("drops encoded messages that exceed the cap or a backpressured socket", () => {
    const oversized = mockViewer();
    expect(safeSendViewer(oversized.socket, { value: "x".repeat(MAX_VIEWER_MESSAGE_BYTES + 1) })).toBe(false);
    expect(oversized.sent).toHaveLength(0);

    const backpressured = mockViewer(MAX_VIEWER_BUFFERED_BYTES + 1);
    expect(safeSendViewer(backpressured.socket, { ok: true })).toBe(false);
    expect(backpressured.sent).toHaveLength(0);
  });

  test("bounds binary chunks and preserves accepted subviews", () => {
    const rejected = mockViewer();
    expect(safeSendViewerBytes(rejected.socket, new Uint8Array())).toBe(false);
    expect(safeSendViewerBytes(rejected.socket, new Uint8Array(MAX_VIEWER_AUDIO_CHUNK_BYTES + 1))).toBe(false);
    expect(rejected.sent).toHaveLength(0);

    const accepted = mockViewer();
    const backing = new Uint8Array([9, 1, 2, 3, 8]);
    expect(safeSendViewerBytes(accepted.socket, backing.subarray(1, 4))).toBe(true);
    expect(accepted.sent).toHaveLength(1);
    expect(Array.from(accepted.sent[0] as Uint8Array)).toEqual([1, 2, 3]);
  });
});
