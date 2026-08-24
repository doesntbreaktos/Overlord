import { describe, expect, test } from "bun:test";
import {
  enqueueSocksBuffer,
  hasSocksConnectionCapacity,
  SOCKS_PROXY_BIND_HOST,
  SOCKS_PROXY_CONNECT_TIMEOUT_SECONDS,
  SOCKS_PROXY_HANDSHAKE_TIMEOUT_SECONDS,
  SOCKS_PROXY_IDLE_TIMEOUT_SECONDS,
  SOCKS_PROXY_MAX_CLIENT_CONNECTIONS,
  SOCKS_PROXY_MAX_CLIENT_LISTENERS,
  SOCKS_PROXY_MAX_GLOBAL_CONNECTIONS,
  SOCKS_PROXY_MAX_GLOBAL_LISTENERS,
  SOCKS_PROXY_MAX_PENDING_BYTES,
  SOCKS_PROXY_MAX_WRITE_QUEUE_BYTES,
} from "./socks5-proxy-manager";

describe("SOCKS proxy security limits", () => {
  test("binds only to loopback by default", () => {
    expect(SOCKS_PROXY_BIND_HOST).toBe("127.0.0.1");
  });

  test("accepts buffers up to a byte limit and rejects overflow without mutating the queue", () => {
    const queue: Buffer[] = [];
    let queuedBytes = enqueueSocksBuffer(queue, 0, Buffer.alloc(4), 6);
    expect(queuedBytes).toBe(4);
    expect(queue).toHaveLength(1);

    queuedBytes = enqueueSocksBuffer(queue, queuedBytes!, Buffer.alloc(3), 6);
    expect(queuedBytes).toBeNull();
    expect(queue).toHaveLength(1);
    expect(queue[0].byteLength).toBe(4);
  });

  test("uses finite pending and slow-writer queue budgets", () => {
    expect(SOCKS_PROXY_MAX_PENDING_BYTES).toBeGreaterThan(0);
    expect(SOCKS_PROXY_MAX_PENDING_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(SOCKS_PROXY_MAX_WRITE_QUEUE_BYTES).toBeGreaterThan(0);
    expect(SOCKS_PROXY_MAX_WRITE_QUEUE_BYTES).toBeLessThanOrEqual(128 * 1024 * 1024);
  });

  test("enforces finite listener and tunnel connection budgets", () => {
    expect(SOCKS_PROXY_MAX_GLOBAL_LISTENERS).toBeGreaterThan(0);
    expect(SOCKS_PROXY_MAX_GLOBAL_LISTENERS).toBeLessThanOrEqual(1_024);
    expect(SOCKS_PROXY_MAX_CLIENT_LISTENERS).toBeGreaterThan(0);
    expect(SOCKS_PROXY_MAX_CLIENT_LISTENERS).toBeLessThanOrEqual(SOCKS_PROXY_MAX_GLOBAL_LISTENERS);

    expect(hasSocksConnectionCapacity(0, 0)).toBe(true);
    expect(hasSocksConnectionCapacity(SOCKS_PROXY_MAX_GLOBAL_CONNECTIONS, 0)).toBe(false);
    expect(hasSocksConnectionCapacity(0, SOCKS_PROXY_MAX_CLIENT_CONNECTIONS)).toBe(false);
  });

  test("uses bounded handshake, connect, and idle timeouts", () => {
    expect(SOCKS_PROXY_HANDSHAKE_TIMEOUT_SECONDS).toBeGreaterThan(0);
    expect(SOCKS_PROXY_HANDSHAKE_TIMEOUT_SECONDS).toBeLessThanOrEqual(30);
    expect(SOCKS_PROXY_CONNECT_TIMEOUT_SECONDS).toBeGreaterThan(0);
    expect(SOCKS_PROXY_CONNECT_TIMEOUT_SECONDS).toBeLessThanOrEqual(60);
    expect(SOCKS_PROXY_IDLE_TIMEOUT_SECONDS).toBeGreaterThan(0);
    expect(SOCKS_PROXY_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(10 * 60);
  });
});
