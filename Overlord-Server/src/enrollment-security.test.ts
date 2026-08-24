import { afterEach, describe, expect, test } from "bun:test";
import * as clientManager from "./clientManager";
import {
  clientExists,
  deleteClientRow,
  getClientEnrollmentStatus,
  getClientBuildOwnership,
  getClientPublicKeyById,
  upsertClientRow,
  upsertPendingClientRow,
} from "./db";
import { encodeMessage } from "./protocol";
import {
  consumeClientIngressBudget,
  createEnrollmentAdmissionController,
  decodeCanonicalBase64,
  getEnrollmentAdmissionStats,
  handleWebSocketClose,
  handleWebSocketMessage,
  handleWebSocketOpen,
  MAX_DISCONNECT_DETAIL_LENGTH,
  MAX_DISCONNECT_REASON_LENGTH,
  MAX_PROXY_TUNNEL_CHUNK_BYTES,
  normalizeDisconnectInfo,
  normalizeProxyTunnelChunk,
} from "./server/routes/websocket-lifecycle-routes";
import type { SocketData } from "./sessions/types";

const createdClientIds = new Set<string>();

afterEach(() => {
  for (const id of createdClientIds) {
    clientManager.deleteClient(id);
    deleteClientRow(id);
  }
  createdClientIds.clear();
});

function uniqueId(label: string): string {
  const id = `security-${label}-${crypto.randomUUID()}`;
  createdClientIds.add(id);
  return id;
}

function createClientSocket(
  clientId: string,
  enrollmentState: SocketData["enrollmentState"],
  enrollmentNonce?: string,
) {
  const closes: Array<{ code: number; reason: string }> = [];
  return {
    data: {
      role: "client",
      clientId,
      ip: "127.0.0.1",
      enrollmentState,
      enrollmentNonce,
    } satisfies SocketData,
    closes,
    sent: [] as Uint8Array[],
    send(message: Uint8Array) {
      this.sent.push(message);
    },
    close(code: number, reason: string) {
      closes.push({ code, reason });
    },
  } as any;
}

function createLifecycleDeps(overrides: Record<string, unknown> = {}) {
  return {
    maxClientPayloadBytes: 1024 * 1024,
    maxViewerPayloadBytes: 1024 * 1024,
    pendingScripts: new Map(),
    pendingCommandReplies: new Map(),
    rdStreamingState: new Map(),
    backstageStreamingState: new Map(),
    webcamStreamingState: new Map(),
    getNotificationConfig: () => ({}),
    dispatchAutoScriptsForConnection() {},
    dispatchAutoDeploysForConnection() {},
    dispatchAutoLoadPlugins() {},
    sendDesktopCommand() {},
    notifyDashboard() {},
    notifyDashboardClientEvent() {},
    broadcastClientEvent() {},
    notifyRemoteDesktopStatus() {},
    notifyRdInputLatency() {},
    handleNotificationScreenshotFailure() {},
    handleFileBrowserMessage() {},
    handleProxyConnectResult() {},
    ...overrides,
  } as any;
}

describe("enrollment identity persistence", () => {
  test("pending enrollment cannot overwrite an approved client's key", () => {
    const victimId = uniqueId("approved-id");
    expect(upsertClientRow({
      id: victimId,
      hwid: "shared-hwid",
      enrollmentStatus: "approved",
      publicKey: "approved-key",
      host: "approved-host",
    })).toBe(true);

    expect(upsertPendingClientRow({
      id: victimId,
      hwid: "shared-hwid",
      enrollmentStatus: "pending",
      publicKey: "attacker-key",
      host: "attacker-host",
    })).toBe(false);

    expect(getClientEnrollmentStatus(victimId)).toBe("approved");
    expect(getClientPublicKeyById(victimId)).toBe("approved-key");
  });

  test("pending enrollment with a colliding HWID does not delete an approved client", () => {
    const victimId = uniqueId("approved-hwid");
    const pendingId = uniqueId("pending-hwid");
    const sharedHwid = `shared-${crypto.randomUUID()}`;

    upsertClientRow({
      id: victimId,
      hwid: sharedHwid,
      enrollmentStatus: "approved",
      publicKey: "approved-key",
    });

    expect(upsertPendingClientRow({
      id: pendingId,
      hwid: sharedHwid,
      enrollmentStatus: "pending",
      publicKey: "pending-key",
    })).toBe(true);

    expect(clientExists(victimId)).toBe(true);
    expect(getClientEnrollmentStatus(victimId)).toBe("approved");
    expect(getClientPublicKeyById(victimId)).toBe("approved-key");
    expect(clientExists(pendingId)).toBe(true);
  });

  test("an approved different-key insert cannot replace or HWID-delete another approved client", () => {
    const victimId = uniqueId("approved-generic");
    const attackerId = uniqueId("approved-generic-attacker");
    const sharedHwid = `shared-${crypto.randomUUID()}`;

    upsertClientRow({
      id: victimId,
      hwid: sharedHwid,
      enrollmentStatus: "approved",
      publicKey: "approved-key",
    });

    expect(upsertClientRow({
      id: victimId,
      hwid: sharedHwid,
      enrollmentStatus: "approved",
      publicKey: "different-key",
    })).toBe(false);
    expect(upsertClientRow({
      id: attackerId,
      hwid: sharedHwid,
      enrollmentStatus: "approved",
      publicKey: "different-key",
    })).toBe(true);

    expect(clientExists(victimId)).toBe(true);
    expect(getClientPublicKeyById(victimId)).toBe("approved-key");
  });

  test("an approved client cannot HWID-delete a denied identity", () => {
    const deniedId = uniqueId("denied-hwid");
    const approvedId = uniqueId("approved-denied-hwid-collision");
    const sharedHwid = `shared-denied-${crypto.randomUUID()}`;

    expect(upsertClientRow({
      id: deniedId,
      hwid: sharedHwid,
      enrollmentStatus: "denied",
      publicKey: `denied-key-${crypto.randomUUID()}`,
    })).toBe(true);

    expect(upsertClientRow({
      id: approvedId,
      hwid: sharedHwid,
      enrollmentStatus: "approved",
      publicKey: `approved-key-${crypto.randomUUID()}`,
    })).toBe(true);

    expect(clientExists(deniedId)).toBe(true);
    expect(getClientEnrollmentStatus(deniedId)).toBe("denied");
    expect(clientExists(approvedId)).toBe(true);
  });

  test("an approved client cannot HWID-delete a pending identity", () => {
    const pendingId = uniqueId("pending-hwid-victim");
    const approvedId = uniqueId("approved-pending-hwid-collision");
    const sharedHwid = `shared-pending-${crypto.randomUUID()}`;

    expect(upsertPendingClientRow({
      id: pendingId,
      hwid: sharedHwid,
      enrollmentStatus: "pending",
      publicKey: `pending-key-${crypto.randomUUID()}`,
      ip: "198.51.100.200",
    })).toBe(true);

    expect(upsertClientRow({
      id: approvedId,
      hwid: sharedHwid,
      enrollmentStatus: "approved",
      publicKey: `approved-key-${crypto.randomUUID()}`,
    })).toBe(true);

    expect(clientExists(pendingId)).toBe(true);
    expect(getClientEnrollmentStatus(pendingId)).toBe("pending");
    expect(clientExists(approvedId)).toBe(true);
  });

  test("a legacy approved row without a key cannot be claimed during enrollment", () => {
    const victimId = uniqueId("legacy-approved");
    upsertClientRow({
      id: victimId,
      enrollmentStatus: "approved",
      host: "legacy-approved-host",
    });

    expect(upsertPendingClientRow({
      id: victimId,
      enrollmentStatus: "pending",
      publicKey: "new-key",
    })).toBe(false);
    expect(getClientEnrollmentStatus(victimId)).toBe("approved");
    expect(getClientPublicKeyById(victimId)).toBeNull();
  });

  test("an enrolled build identity cannot be overwritten by client metadata", () => {
    const clientId = uniqueId("immutable-build");
    upsertClientRow({
      id: clientId,
      enrollmentStatus: "approved",
      publicKey: "approved-key",
      buildTag: "enrolled-build-tag",
      builtByUserId: 10,
    });

    upsertClientRow({
      id: clientId,
      enrollmentStatus: "approved",
      publicKey: "approved-key",
      buildTag: "attacker-selected-tag",
      builtByUserId: 999,
    });

    expect(getClientBuildOwnership(clientId)).toEqual({
      buildTag: "enrolled-build-tag",
      builtByUserId: 10,
    });
  });

  test("one public key cannot reserve two client identities", async () => {
    const firstId = uniqueId("same-key-first");
    const secondId = uniqueId("same-key-second");
    const publicKey = `shared-key-${crypto.randomUUID()}`;

    const results = await Promise.all([
      Promise.resolve().then(() => upsertPendingClientRow({
        id: firstId,
        publicKey,
        enrollmentStatus: "pending",
      })),
      Promise.resolve().then(() => upsertPendingClientRow({
        id: secondId,
        publicKey,
        enrollmentStatus: "pending",
      })),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect([clientExists(firstId), clientExists(secondId)].filter(Boolean)).toHaveLength(1);
  });

  test("one public key cannot reserve two approved identities", async () => {
    const firstId = uniqueId("approved-same-key-first");
    const secondId = uniqueId("approved-same-key-second");
    const publicKey = `approved-shared-key-${crypto.randomUUID()}`;
    const results = await Promise.all([
      Promise.resolve().then(() => upsertClientRow({
        id: firstId,
        publicKey,
        enrollmentStatus: "approved",
      })),
      Promise.resolve().then(() => upsertClientRow({
        id: secondId,
        publicKey,
        enrollmentStatus: "approved",
      })),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect([clientExists(firstId), clientExists(secondId)].filter(Boolean)).toHaveLength(1);
  });

  test("caps fresh pending identities per source IP", () => {
    const envName = "OVERLORD_MAX_PENDING_ENROLLMENTS_PER_IP";
    const saved = process.env[envName];
    process.env[envName] = "1";
    try {
      const firstId = uniqueId("ip-cap-first");
      const secondId = uniqueId("ip-cap-second");
      const ip = `198.51.100.${Math.floor(Math.random() * 100 + 1)}`;
      expect(upsertPendingClientRow({
        id: firstId,
        publicKey: `ip-key-${crypto.randomUUID()}`,
        enrollmentStatus: "pending",
        ip,
      })).toBe(true);
      expect(upsertPendingClientRow({
        id: secondId,
        publicKey: `ip-key-${crypto.randomUUID()}`,
        enrollmentStatus: "pending",
        ip,
      })).toBe(false);
    } finally {
      if (saved === undefined) delete process.env[envName];
      else process.env[envName] = saved;
    }
  });
});

describe("client websocket ingress budget", () => {
  test("bounds repeated giant frames before MessagePack decoding", () => {
    const data = { role: "client", clientId: "budget-test" } as SocketData;
    const giantFrame = 64 * 1024 * 1024;
    expect(consumeClientIngressBudget(data, giantFrame, 1_000)).toBe(true);
    expect(consumeClientIngressBudget(data, giantFrame, 1_000)).toBe(true);
    expect(consumeClientIngressBudget(data, 1, 1_000)).toBe(false);
    expect(consumeClientIngressBudget(data, giantFrame, 3_000)).toBe(true);
  });

  test("bounds tiny-message floods independently of byte volume", () => {
    const data = { role: "client", clientId: "message-budget-test" } as SocketData;
    for (let i = 0; i < 512; i += 1) {
      expect(consumeClientIngressBudget(data, 1, 10_000)).toBe(true);
    }
    expect(consumeClientIngressBudget(data, 1, 10_000)).toBe(false);
    expect(consumeClientIngressBudget(data, 1, 11_000)).toBe(true);
  });
});

describe("pre-auth enrollment admission", () => {
  test("caps active challenges globally and per IP with idempotent release", () => {
    const controller = createEnrollmentAdmissionController({
      maxActiveGlobal: 2,
      maxActivePerIp: 1,
      maxVerifyingGlobal: 1,
      verificationAttemptsPerSecond: 1,
      verificationAttemptBurst: 2,
    });
    const first = {};
    const sameIp = {};
    const secondIp = {};
    const overGlobal = {};

    expect(controller.admit(first, "198.51.100.1")).toEqual({ ok: true });
    expect(controller.admit(sameIp, "198.51.100.1")).toEqual({
      ok: false,
      reason: "per_ip_socket_limit",
    });
    expect(controller.admit(secondIp, "198.51.100.2")).toEqual({ ok: true });
    expect(controller.admit(overGlobal, "198.51.100.3")).toEqual({
      ok: false,
      reason: "global_socket_limit",
    });
    expect(controller.stats("198.51.100.1")).toMatchObject({
      active: 2,
      activeForIp: 1,
      verifying: 0,
    });

    expect(controller.release(first)).toBe(true);
    expect(controller.release(first)).toBe(false);
    expect(controller.admit(overGlobal, "198.51.100.3")).toEqual({ ok: true });
  });

  test("bounds concurrent verification and refills a global attempt bucket", () => {
    const controller = createEnrollmentAdmissionController({
      maxActiveGlobal: 4,
      maxActivePerIp: 4,
      maxVerifyingGlobal: 1,
      verificationAttemptsPerSecond: 1,
      verificationAttemptBurst: 2,
    });
    const first = {};
    const second = {};
    const third = {};
    for (const socket of [first, second, third]) {
      expect(controller.admit(socket, "203.0.113.1")).toEqual({ ok: true });
    }

    expect(controller.beginVerification(first, 1_000)).toEqual({ ok: true });
    expect(controller.beginVerification(second, 1_000)).toEqual({
      ok: false,
      reason: "verification_concurrency",
    });
    expect(controller.release(first)).toBe(true);
    expect(controller.beginVerification(second, 1_000)).toEqual({ ok: true });
    expect(controller.release(second)).toBe(true);
    expect(controller.beginVerification(third, 1_000)).toEqual({
      ok: false,
      reason: "verification_rate",
    });
    expect(controller.beginVerification(third, 2_000)).toEqual({ ok: true });
    expect(controller.stats()).toMatchObject({ active: 1, verifying: 1 });
    expect(controller.release(third)).toBe(true);
    expect(controller.stats()).toMatchObject({ active: 0, verifying: 0 });
  });
});

describe("client disconnect metadata", () => {
  test("strips controls and clamps agent-supplied values before persistence", () => {
    const normalized = normalizeDisconnectInfo({
      reason: `  crash\r\nforged-log\t\u0000${"r".repeat(MAX_DISCONNECT_REASON_LENGTH + 100)}  `,
      detail: `  detail\u0007${"d".repeat(MAX_DISCONNECT_DETAIL_LENGTH + 100)}  `,
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.reason).not.toContain("\u0000");
    expect(normalized?.reason).not.toMatch(/[\r\n\t]/);
    expect(normalized?.reason).toStartWith("crash forged-log ");
    expect(normalized?.detail).not.toContain("\u0007");
    expect(normalized?.reason.length).toBeLessThanOrEqual(MAX_DISCONNECT_REASON_LENGTH);
    expect(normalized?.detail?.length).toBeLessThanOrEqual(MAX_DISCONNECT_DETAIL_LENGTH);

    const exact = normalizeDisconnectInfo({
      reason: "r".repeat(MAX_DISCONNECT_REASON_LENGTH + 1),
      detail: "d".repeat(MAX_DISCONNECT_DETAIL_LENGTH + 1),
    });
    expect(exact?.reason.length).toBe(MAX_DISCONNECT_REASON_LENGTH);
    expect(exact?.detail?.length).toBe(MAX_DISCONNECT_DETAIL_LENGTH);
  });

  test("rejects missing or empty reasons", () => {
    expect(normalizeDisconnectInfo(null)).toBeNull();
    expect(normalizeDisconnectInfo({ reason: " \u0000\u0007 " })).toBeNull();
    expect(normalizeDisconnectInfo({ reason: 42, detail: "ignored" })).toBeNull();
  });
});

describe("proxy tunnel payload validation", () => {
  test("rejects scalar allocation lengths and oversized chunks", () => {
    expect(normalizeProxyTunnelChunk(0xffff_ffff)).toBeNull();
    expect(normalizeProxyTunnelChunk({ length: 0xffff_ffff })).toBeNull();
    expect(normalizeProxyTunnelChunk(new Uint8Array(MAX_PROXY_TUNNEL_CHUNK_BYTES + 1))).toBeNull();
  });

  test("preserves an accepted view's exact offset and length", () => {
    const backing = new Uint8Array([9, 1, 2, 3, 8]);
    const view = new DataView(backing.buffer, 1, 3);
    expect(normalizeProxyTunnelChunk(view)).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("pre-enrollment websocket handling", () => {
  test("strictly rejects non-canonical public keys before identity lookup", async () => {
    const deniedId = uniqueId("denied-key-alias");
    const claimedId = uniqueId("denied-key-alias-claim");
    const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keyPair.publicKey)).toString("base64");
    expect(upsertClientRow({
      id: deniedId,
      hwid: deniedId,
      role: "client",
      publicKey,
      enrollmentStatus: "denied",
    })).toBe(true);

    expect(decodeCanonicalBase64(publicKey, 32)).not.toBeNull();
    expect(decodeCanonicalBase64(`${publicKey}!!`, 32)).toBeNull();
    expect(decodeCanonicalBase64(` ${publicKey}`, 32)).toBeNull();

    const deps = createLifecycleDeps();
    const ws = createClientSocket(claimedId, undefined);
    const activeBefore = getEnrollmentAdmissionStats().active;
    handleWebSocketOpen(ws, deps);
    const nonceBytes = Buffer.from(ws.data.enrollmentNonce!, "base64");
    const signature = Buffer.from(
      await crypto.subtle.sign("Ed25519", keyPair.privateKey, nonceBytes),
    ).toString("base64");
    await handleWebSocketMessage(
      ws,
      encodeMessage({
        type: "hello",
        id: claimedId,
        host: "host",
        os: "test",
        arch: "x64",
        version: "1",
        user: "user",
        monitors: 1,
        publicKey: `${publicKey}!!`,
        signature,
      }),
      deps,
    );

    expect(ws.closes).toContainEqual({ code: 4002, reason: "invalid_signature" });
    expect(getEnrollmentAdmissionStats().active).toBe(activeBefore);
    expect(getClientEnrollmentStatus(deniedId)).toBe("denied");
    expect(clientExists(claimedId)).toBe(false);
  });

  test("same-ID sockets retain independent enrollment timeouts", () => {
    const clientId = uniqueId("same-id-timeouts");
    const firstSocket = createClientSocket(clientId, undefined);
    const secondSocket = createClientSocket(clientId, undefined);
    const deps = createLifecycleDeps();
    const activeBefore = getEnrollmentAdmissionStats().active;

    handleWebSocketOpen(firstSocket, deps);
    handleWebSocketOpen(secondSocket, deps);

    expect(getEnrollmentAdmissionStats("127.0.0.1").activeForIp).toBeGreaterThanOrEqual(2);

    expect(firstSocket.data.enrollmentTimeout).toBeDefined();
    expect(secondSocket.data.enrollmentTimeout).toBeDefined();
    expect(firstSocket.data.enrollmentTimeout).not.toBe(secondSocket.data.enrollmentTimeout);

    handleWebSocketClose(secondSocket, 1000, "closed", deps);
    expect(secondSocket.data.enrollmentTimeout).toBeUndefined();
    expect(firstSocket.data.enrollmentTimeout).toBeDefined();

    handleWebSocketClose(firstSocket, 1000, "closed", deps);
    expect(firstSocket.data.enrollmentTimeout).toBeUndefined();
    expect(getEnrollmentAdmissionStats().active).toBe(activeBefore);
  });

  test("consumes the challenge before awaiting verification and rejects concurrent hello", async () => {
    const clientId = uniqueId("double-hello");
    const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const publicKey = Buffer.from(
      await crypto.subtle.exportKey("raw", keyPair.publicKey),
    ).toString("base64");
    const ws = createClientSocket(clientId, undefined);
    const deps = createLifecycleDeps();
    const admissionBefore = getEnrollmentAdmissionStats();
    handleWebSocketOpen(ws, deps);
    const nonceBytes = Buffer.from(ws.data.enrollmentNonce!, "base64");
    const signature = Buffer.from(
      await crypto.subtle.sign("Ed25519", keyPair.privateKey, nonceBytes),
    ).toString("base64");
    const hello = encodeMessage({
      type: "hello",
      id: clientId,
      host: "host",
      os: "test",
      arch: "x64",
      version: "1",
      user: "user",
      monitors: 1,
      publicKey,
      signature,
    });

    const firstHello = handleWebSocketMessage(ws, hello, deps);
    expect(ws.data.enrollmentNonce).toBeUndefined();
    expect(ws.data.enrollmentState).toBe("verifying");
    expect(getEnrollmentAdmissionStats().verifying).toBe(admissionBefore.verifying + 1);

    const secondHello = handleWebSocketMessage(ws, hello, deps);
    await Promise.all([firstHello, secondHello]);

    expect(ws.data.enrollmentState).toBe("rejected");
    expect(ws.closes).toContainEqual({ code: 4002, reason: "unexpected_hello" });
    expect(getEnrollmentAdmissionStats()).toMatchObject({
      active: admissionBefore.active,
      verifying: admissionBefore.verifying,
    });
    expect(clientManager.hasClient(clientId)).toBe(false);
  });

  test("releases challenge and verification capacity after authentication", async () => {
    const clientId = uniqueId("admission-auth-release");
    const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const publicKey = Buffer.from(
      await crypto.subtle.exportKey("raw", keyPair.publicKey),
    ).toString("base64");
    expect(upsertClientRow({
      id: clientId,
      publicKey,
      enrollmentStatus: "approved",
    })).toBe(true);

    const ws = createClientSocket(clientId, undefined);
    const deps = createLifecycleDeps();
    const before = getEnrollmentAdmissionStats();
    handleWebSocketOpen(ws, deps);
    expect(getEnrollmentAdmissionStats()).toMatchObject({
      active: before.active + 1,
      verifying: before.verifying,
    });

    const nonceBytes = Buffer.from(ws.data.enrollmentNonce!, "base64");
    const signature = Buffer.from(
      await crypto.subtle.sign("Ed25519", keyPair.privateKey, nonceBytes),
    ).toString("base64");
    await handleWebSocketMessage(ws, encodeMessage({
      type: "hello",
      id: clientId,
      host: "host",
      os: "test",
      arch: "x64",
      version: "1",
      user: "user",
      monitors: 1,
      publicKey,
      signature,
    }), deps);

    expect(ws.data.enrollmentState).toBe("authenticated");
    expect(clientManager.getClient(clientId)?.ws).toBe(ws);
    expect(getEnrollmentAdmissionStats()).toMatchObject({
      active: before.active,
      verifying: before.verifying,
    });
  });

  test("rejects a large frame before enrollment decoding", async () => {
    const clientId = uniqueId("large-pre-enrollment-frame");
    const ws = createClientSocket(clientId, undefined);
    const deps = createLifecycleDeps();
    const activeBefore = getEnrollmentAdmissionStats().active;
    handleWebSocketOpen(ws, deps);

    await handleWebSocketMessage(
      ws,
      new Uint8Array(32 * 1024 + 1),
      deps,
    );

    expect(ws.closes).toEqual([
      { code: 1009, reason: "Pre-enrollment message too large" },
    ]);
    expect(ws.data.enrollmentState).toBe("rejected");
    expect(getEnrollmentAdmissionStats().active).toBe(activeBefore);
  });

  test("unauthenticated close cannot consume another client's pending work", () => {
    const claimedId = uniqueId("preauth-close");
    const timeout = setTimeout(() => {}, 60_000);
    const pendingCommandReplies = new Map([
      ["pending-command", { clientId: claimedId, timeout, resolve() {} }],
    ]);
    const ws = createClientSocket(claimedId, undefined);
    const deps = createLifecycleDeps({ pendingCommandReplies });
    const activeBefore = getEnrollmentAdmissionStats().active;
    handleWebSocketOpen(ws, deps);

    handleWebSocketClose(
      ws,
      1000,
      "closed",
      deps,
    );

    clearTimeout(timeout);
    expect(pendingCommandReplies.has("pending-command")).toBe(true);
    expect(getEnrollmentAdmissionStats().active).toBe(activeBefore);
  });
});

describe("client-bound pending responses", () => {
  test("a superseded authenticated socket cannot inject messages", async () => {
    const clientId = uniqueId("superseded-socket");
    const staleWs = createClientSocket(clientId, "authenticated");
    const currentWs = createClientSocket(clientId, "authenticated");
    clientManager.addClient(clientId, {
      id: clientId,
      role: "client",
      ws: currentWs,
      lastSeen: Date.now(),
      online: true,
    });
    let notifications = 0;
    await handleWebSocketMessage(
      staleWs,
      encodeMessage({ type: "notification", title: "spoofed" } as any),
      createLifecycleDeps({ handleNotification() { notifications += 1; } }),
    );
    expect(notifications).toBe(0);
    expect(staleWs.closes).toContainEqual({ code: 4004, reason: "superseded" });
    expect(clientManager.getClient(clientId)?.ws).toBe(currentWs);
  });

  test("wrong client cannot resolve command, logs, or script replies", async () => {
    const senderId = uniqueId("reply-sender");
    const expectedId = uniqueId("reply-owner");
    const ws = createClientSocket(senderId, "authenticated");
    clientManager.addClient(senderId, {
      id: senderId,
      role: "client",
      ws,
      lastSeen: Date.now(),
      online: true,
    });

    let commandResolutions = 0;
    let scriptResolutions = 0;
    const commandTimeout = setTimeout(() => {}, 60_000);
    const logTimeout = setTimeout(() => {}, 60_000);
    const scriptTimeout = setTimeout(() => {}, 60_000);
    const pendingCommandReplies = new Map([
      ["command-id", {
        clientId: expectedId,
        timeout: commandTimeout,
        resolve() { commandResolutions += 1; },
      }],
      ["logs-id", {
        clientId: expectedId,
        timeout: logTimeout,
        resolve() { commandResolutions += 1; },
      }],
    ]);
    const pendingScripts = new Map([
      ["script-id", {
        clientId: expectedId,
        timeout: scriptTimeout,
        resolve() { scriptResolutions += 1; },
      }],
    ]);
    let screenshotFailureClientId: string | undefined;
    const deps = createLifecycleDeps({
      pendingCommandReplies,
      pendingScripts,
      handleNotificationScreenshotFailure(
        _commandId: string | undefined,
        _ok: boolean | undefined,
        _message: string | undefined,
        clientId: string | undefined,
      ) {
        screenshotFailureClientId = clientId;
      },
    });

    await handleWebSocketMessage(ws, encodeMessage({
      type: "command_result",
      commandId: "command-id",
      ok: false,
    }), deps);
    await handleWebSocketMessage(ws, encodeMessage({
      type: "client_logs_result",
      commandId: "logs-id",
      ok: true,
      lines: [],
    } as any), deps);
    await handleWebSocketMessage(ws, encodeMessage({
      type: "script_result",
      commandId: "script-id",
      ok: true,
      output: "spoofed",
    }), deps);

    clearTimeout(commandTimeout);
    clearTimeout(logTimeout);
    clearTimeout(scriptTimeout);
    expect(commandResolutions).toBe(0);
    expect(scriptResolutions).toBe(0);
    expect(pendingCommandReplies.has("command-id")).toBe(true);
    expect(pendingCommandReplies.has("logs-id")).toBe(true);
    expect(pendingScripts.has("script-id")).toBe(true);
    expect(screenshotFailureClientId).toBe(senderId);
  });
});
