import { describe, expect, test } from "bun:test";
import { encode } from "@msgpack/msgpack";
import {
  DEFAULT_UNTRUSTED_MESSAGEPACK_LIMITS,
  MessagePackPreflightError,
  preflightMessagePack,
} from "./messagepack-preflight";
import { decodeMessage } from "./protocol";

function container32(prefix: 0xdd | 0xdf, count: number): Uint8Array {
  return new Uint8Array([
    prefix,
    (count >>> 24) & 0xff,
    (count >>> 16) & 0xff,
    (count >>> 8) & 0xff,
    count & 0xff,
  ]);
}

describe("MessagePack allocation preflight", () => {
  test("accepts normal mixed wire data and Uint8Array subviews", () => {
    const encoded = encode({
      type: "ping",
      ts: 123.5,
      nested: [null, true, -300, "hello", new Uint8Array([1, 2, 3])],
      metadata: { ok: true },
    });
    const backing = new Uint8Array(encoded.byteLength + 2);
    backing.set(encoded, 1);
    const subview = backing.subarray(1, backing.length - 1);

    expect(() => preflightMessagePack(subview)).not.toThrow();
    expect((decodeMessage(subview) as any).nested[4]).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("accepts fixed and variable extension framing", () => {
    expect(() => preflightMessagePack(new Uint8Array([0xd4, 0x01, 0xff]))).not.toThrow();
    expect(() => preflightMessagePack(new Uint8Array([0xc7, 0x00, 0x01]))).not.toThrow();
  });

  test("accepts encoder output across 16-bit and 32-bit length boundaries", () => {
    const value = {
      mediumText: "m".repeat(300),
      largeText: "l".repeat(70_000),
      mediumBytes: new Uint8Array(300),
      largeBytes: new Uint8Array(70_000),
      array16: Array.from({ length: 20 }, (_, index) => index),
      map16: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${index}`, index])),
    };

    expect(() => preflightMessagePack(encode(value))).not.toThrow();
  });

  test("does not impose the former low container-item limit", () => {
    const aboveFormerLimit = 16_385;
    for (const prefix of [0xdd, 0xdf] as const) {
      expect(() => preflightMessagePack(container32(prefix, aboveFormerLimit)))
        .toThrow("truncated value header");
    }
  });

  test("rejects depth amplification while allowing the configured boundary", () => {
    const allowed = new Uint8Array([
      ...new Array(DEFAULT_UNTRUSTED_MESSAGEPACK_LIMITS.maxDepth - 1).fill(0x91),
      0xc0,
    ]);
    const tooDeep = new Uint8Array([
      ...new Array(DEFAULT_UNTRUSTED_MESSAGEPACK_LIMITS.maxDepth).fill(0x91),
      0xc0,
    ]);

    expect(() => preflightMessagePack(allowed)).not.toThrow();
    expect(() => preflightMessagePack(tooDeep)).toThrow("nesting depth limit exceeded");
  });

  test("accepts aggregate value counts above the former fixed ceiling", () => {
    const payload = encode(Array.from({ length: 70_000 }, (_, index) => [index]));
    expect(() => preflightMessagePack(payload)).not.toThrow();
  });

  test("rejects truncated strings and containers", () => {
    expect(() => preflightMessagePack(new Uint8Array([0xdb, 0, 0, 0, 4, 0x61])))
      .toThrow("truncated str32 body");
    expect(() => preflightMessagePack(new Uint8Array([0x91])))
      .toThrow("truncated value header");
  });

  test("requires exactly one root value and rejects reserved prefixes", () => {
    expect(() => preflightMessagePack(new Uint8Array([0xc0, 0xc0])))
      .toThrow("trailing bytes after root value");
    expect(() => preflightMessagePack(new Uint8Array([0xc1])))
      .toThrow(MessagePackPreflightError);
  });

  test("decodeMessage applies the preflight before the library decoder", () => {
    const declaredBillions = container32(0xdd, 0xffff_ffff);
    expect(() => decodeMessage(declaredBillions))
      .toThrow("truncated value header");
  });
});
