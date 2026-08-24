/**
 * Server-side SOCKS5 proxy manager.
 *
 * Opens TCP listeners on the Overlord server. Each listener is bound to a
 * specific agent (clientId).  When an external SOCKS5 client connects, the
 * server performs the SOCKS5 handshake locally and then tunnels the
 * connection through the agent's existing WebSocket channel.
 *
 * Protocol (new message types piggybacking on the existing wire format):
 *   Server → Agent  command { commandType: "proxy_connect", id: connId, payload: { host, port } }
 *   Server → Agent  command { commandType: "proxy_data",    id: connId, payload: { data: Uint8Array } }
 *   Server → Agent  command { commandType: "proxy_close",   id: connId }
 *   Agent  → Server { type: "proxy_data",  connectionId, data: Uint8Array }
 *   Agent  → Server { type: "proxy_close", connectionId }
 *   Agent  → Server { type: "command_result", commandId: connId, ok, message }  (for proxy_connect result)
 */

import type { Socket, TCPSocketListener } from "bun";
import { v4 as uuidv4 } from "uuid";
import { encodeMessage } from "../protocol";
import * as clientManager from "../clientManager";
import { logger } from "../logger";

export const SOCKS_PROXY_BIND_HOST = "127.0.0.1";
export const SOCKS_PROXY_MAX_PENDING_BYTES = 64 * 1024 * 1024;
export const SOCKS_PROXY_MAX_WRITE_QUEUE_BYTES = 128 * 1024 * 1024;
export const SOCKS_PROXY_MAX_GLOBAL_CONNECTIONS = 4_096;
export const SOCKS_PROXY_MAX_CLIENT_CONNECTIONS = 1_024;
export const SOCKS_PROXY_MAX_GLOBAL_LISTENERS = 1_024;
export const SOCKS_PROXY_MAX_CLIENT_LISTENERS = 256;
export const SOCKS_PROXY_HANDSHAKE_TIMEOUT_SECONDS = 15;
export const SOCKS_PROXY_CONNECT_TIMEOUT_SECONDS = 30;
export const SOCKS_PROXY_IDLE_TIMEOUT_SECONDS = 5 * 60;
const SOCKS_PROXY_MAX_HANDSHAKE_BYTES = 8 * 1024;

export function hasSocksConnectionCapacity(
  globalConnections: number,
  clientConnections: number,
): boolean {
  return globalConnections < SOCKS_PROXY_MAX_GLOBAL_CONNECTIONS
    && clientConnections < SOCKS_PROXY_MAX_CLIENT_CONNECTIONS;
}

export function enqueueSocksBuffer(
  queue: Buffer[],
  currentBytes: number,
  data: Buffer | Uint8Array,
  maxBytes: number,
): number | null {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buffer.byteLength === 0) return currentBytes;
  if (currentBytes < 0 || buffer.byteLength > maxBytes - currentBytes) return null;
  queue.push(buffer);
  return currentBytes + buffer.byteLength;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProxyEntry = {
  clientId: string;
  port: number;
  listener: TCPSocketListener<ProxySocketData>;
  /** active tunnel connections keyed by connectionId */
  connections: Map<string, TunnelConnection>;
  createdAt: number;
};

type TunnelConnection = {
  socket: Socket<ProxySocketData>;
  /** whether the agent has confirmed the target connection */
  connected: boolean;
  /** buffer data received from SOCKS client before agent confirms */
  pendingData: Buffer[];
  pendingDataBytes: number;
  /** data destined for the SOCKS client that the kernel buffer rejected; flushed on drain */
  writeQueue: Buffer[];
  writeQueueBytes: number;
};

type ProxySocketData = {
  connectionId: string;
  proxyPort: number;
  /** SOCKS5 handshake phase */
  phase: "greeting" | "request" | "tunneling";
  buffer: Buffer;
  /** Absolute deadline for handshake or agent-connect completion. */
  phaseDeadline: number;
};

// ── State ─────────────────────────────────────────────────────────────────────

/** port → ProxyEntry */
const activeProxies = new Map<number, ProxyEntry>();

// ── Public API ────────────────────────────────────────────────────────────────

export function getActiveProxies(): Array<{
  clientId: string;
  port: number;
  connections: number;
  createdAt: number;
}> {
  const out: Array<{
    clientId: string;
    port: number;
    connections: number;
    createdAt: number;
  }> = [];
  for (const [port, entry] of activeProxies) {
    out.push({
      clientId: entry.clientId,
      port,
      connections: entry.connections.size,
      createdAt: entry.createdAt,
    });
  }
  return out;
}

export function startProxy(
  clientId: string,
  port: number,
): { ok: boolean; message: string } {
  if (activeProxies.has(port)) {
    return { ok: false, message: `Port ${port} is already in use by another proxy` };
  }

  if (activeProxies.size >= SOCKS_PROXY_MAX_GLOBAL_LISTENERS) {
    return { ok: false, message: "Global SOCKS5 proxy listener limit reached" };
  }
  let clientListenerCount = 0;
  for (const entry of activeProxies.values()) {
    if (entry.clientId === clientId) clientListenerCount += 1;
  }
  if (clientListenerCount >= SOCKS_PROXY_MAX_CLIENT_LISTENERS) {
    return { ok: false, message: `SOCKS5 proxy listener limit reached for client ${clientId}` };
  }

  const target = clientManager.getClient(clientId);
  if (!target) {
    return { ok: false, message: `Client ${clientId} is not connected` };
  }

  const connections = new Map<string, TunnelConnection>();

  try {
    const listener = Bun.listen<ProxySocketData>({
      hostname: SOCKS_PROXY_BIND_HOST,
      port,
      socket: {
        open(socket) {
          const connectionId = uuidv4();
          const now = Date.now();
          socket.data = {
            connectionId,
            proxyPort: port,
            phase: "greeting",
            buffer: Buffer.alloc(0),
            phaseDeadline: now + SOCKS_PROXY_HANDSHAKE_TIMEOUT_SECONDS * 1000,
          };

          let globalConnections = 0;
          let clientConnections = 0;
          for (const activeEntry of activeProxies.values()) {
            globalConnections += activeEntry.connections.size;
            if (activeEntry.clientId === clientId) {
              clientConnections += activeEntry.connections.size;
            }
          }
          if (!hasSocksConnectionCapacity(globalConnections, clientConnections)) {
            logger.warn(
              `[socks5] rejected connection on port ${port}: active connection limit reached`,
            );
            socket.end();
            return;
          }

          connections.set(connectionId, {
            socket,
            connected: false,
            pendingData: [],
            pendingDataBytes: 0,
            writeQueue: [],
            writeQueueBytes: 0,
          });
          socket.timeout(SOCKS_PROXY_HANDSHAKE_TIMEOUT_SECONDS);
          logger.debug(
            `[socks5] new connection ${connectionId} on port ${port}`,
          );
        },

        data(socket, data) {
          const entry = activeProxies.get(socket.data.proxyPort);
          if (!entry) {
            socket.end();
            return;
          }
          handleSocksData(socket, Buffer.from(data), entry);
        },

        close(socket) {
          const entry = activeProxies.get(socket.data.proxyPort);
          if (!entry) return;
          const connId = socket.data.connectionId;
          const tunnel = entry.connections.get(connId);
          if (tunnel) {
            entry.connections.delete(connId);
            // tell agent to close its side
            const agent = clientManager.getClient(entry.clientId);
            if (agent) {
              try {
                agent.ws.send(
                  encodeMessage({
                    type: "command",
                    commandType: "proxy_close",
                    id: connId,
                  } as any),
                );
              } catch {}
            }
          }
          logger.debug(`[socks5] connection ${connId} closed`);
        },

        drain(socket) {
          const entry = activeProxies.get(socket.data.proxyPort);
          if (!entry) return;
          const tunnel = entry.connections.get(socket.data.connectionId);
          if (!tunnel) return;
          flushWriteQueue(tunnel);
        },

        timeout(socket) {
          const entry = activeProxies.get(socket.data.proxyPort);
          const tunnel = entry?.connections.get(socket.data.connectionId);
          if (entry && tunnel) {
            closeTunnel(entry, tunnel, "timeout");
          } else {
            try { socket.end(); } catch {}
          }
        },

        error(socket, err) {
          logger.error(
            `[socks5] socket error conn=${socket.data?.connectionId}`,
            err,
          );
        },
      },
    });

    const entry: ProxyEntry = {
      clientId,
      port,
      listener,
      connections,
      createdAt: Date.now(),
    };
    activeProxies.set(port, entry);
    logger.info(
      `[socks5] proxy started on ${SOCKS_PROXY_BIND_HOST}:${port} for client ${clientId}`,
    );
    return { ok: true, message: `Proxy started on ${SOCKS_PROXY_BIND_HOST}:${port}` };
  } catch (err: any) {
    return {
      ok: false,
      message: `Failed to listen on port ${port}: ${err.message || err}`,
    };
  }
}

export function stopProxy(port: number): { ok: boolean; message: string } {
  const entry = activeProxies.get(port);
  if (!entry) {
    return { ok: false, message: `No proxy running on port ${port}` };
  }

  // close all tunnel connections
  for (const [connId, tunnel] of entry.connections) {
    try {
      tunnel.socket.end();
    } catch {}
    // notify agent
    const agent = clientManager.getClient(entry.clientId);
    if (agent) {
      try {
        agent.ws.send(
          encodeMessage({
            type: "command",
            commandType: "proxy_close",
            id: connId,
          } as any),
        );
      } catch {}
    }
  }

  entry.listener.stop(true);
  activeProxies.delete(port);
  logger.info(`[socks5] proxy stopped on port ${port}`);
  return { ok: true, message: `Proxy on port ${port} stopped` };
}

export function stopAllProxiesForClient(clientId: string): void {
  for (const [port, entry] of activeProxies) {
    if (entry.clientId === clientId) {
      stopProxy(port);
    }
  }
}


export function handleProxyTunnelData(
  clientId: string,
  connectionId: string,
  data: Uint8Array,
): void {
  for (const entry of activeProxies.values()) {
    if (entry.clientId !== clientId) continue;
    const tunnel = entry.connections.get(connectionId);
    if (tunnel) {
      writeToTunnelSocket(tunnel, data);
      return;
    }
  }
}

function closeTunnel(
  entry: ProxyEntry,
  tunnel: TunnelConnection,
  reason: string,
): void {
  const connectionId = tunnel.socket.data.connectionId;
  tunnel.pendingData = [];
  tunnel.pendingDataBytes = 0;
  tunnel.writeQueue = [];
  tunnel.writeQueueBytes = 0;
  entry.connections.delete(connectionId);
  logger.warn(`[socks5] closing ${connectionId}: ${reason}`);
  try { tunnel.socket.end(); } catch {}

  const agent = clientManager.getClient(entry.clientId);
  if (!agent) return;
  try {
    agent.ws.send(
      encodeMessage({
        type: "command",
        commandType: "proxy_close",
        id: connectionId,
      } as any),
    );
  } catch {}
}

function closeTunnelForBufferOverflow(
  entry: ProxyEntry | undefined,
  tunnel: TunnelConnection,
  queueName: "pending" | "write",
): void {
  if (entry) {
    closeTunnel(entry, tunnel, `${queueName} buffer limit exceeded`);
    return;
  }
  tunnel.pendingData = [];
  tunnel.pendingDataBytes = 0;
  tunnel.writeQueue = [];
  tunnel.writeQueueBytes = 0;
  try { tunnel.socket.end(); } catch {}
}

function writeToTunnelSocket(
  tunnel: TunnelConnection,
  data: Buffer | Uint8Array,
): void {
  tunnel.socket.timeout(SOCKS_PROXY_IDLE_TIMEOUT_SECONDS);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (tunnel.writeQueue.length > 0) {
    const nextBytes = enqueueSocksBuffer(
      tunnel.writeQueue,
      tunnel.writeQueueBytes,
      buf,
      SOCKS_PROXY_MAX_WRITE_QUEUE_BYTES,
    );
    if (nextBytes === null) {
      closeTunnelForBufferOverflow(
        activeProxies.get(tunnel.socket.data.proxyPort),
        tunnel,
        "write",
      );
      return;
    }
    tunnel.writeQueueBytes = nextBytes;
    return;
  }
  let written: number;
  try {
    written = tunnel.socket.write(buf);
  } catch {
    return;
  }
  if (written < buf.length) {
    const remaining = buf.subarray(Math.max(written, 0));
    const nextBytes = enqueueSocksBuffer(
      tunnel.writeQueue,
      tunnel.writeQueueBytes,
      remaining,
      SOCKS_PROXY_MAX_WRITE_QUEUE_BYTES,
    );
    if (nextBytes === null) {
      closeTunnelForBufferOverflow(
        activeProxies.get(tunnel.socket.data.proxyPort),
        tunnel,
        "write",
      );
      return;
    }
    tunnel.writeQueueBytes = nextBytes;
  }
}

function flushWriteQueue(tunnel: TunnelConnection): void {
  while (tunnel.writeQueue.length > 0) {
    const next = tunnel.writeQueue[0];
    let written: number;
    try {
      written = tunnel.socket.write(next);
    } catch {
      tunnel.writeQueue.length = 0;
      tunnel.writeQueueBytes = 0;
      return;
    }
    if (written < next.length) {
      const consumed = Math.max(written, 0);
      tunnel.writeQueueBytes -= consumed;
      tunnel.writeQueue[0] = next.subarray(consumed);
      return;
    }
    tunnel.writeQueue.shift();
    tunnel.writeQueueBytes -= next.length;
  }
  tunnel.writeQueueBytes = 0;
}

/** Called when the agent closes its side of a tunnel */
export function handleProxyTunnelClose(
  clientId: string,
  connectionId: string,
): void {
  for (const entry of activeProxies.values()) {
    if (entry.clientId !== clientId) continue;
    const tunnel = entry.connections.get(connectionId);
    if (tunnel) {
      entry.connections.delete(connectionId);
      try {
        tunnel.socket.end();
      } catch {}
      return;
    }
  }
}

export function handleProxyConnectResult(
  clientId: string,
  connectionId: string,
  ok: boolean,
): void {
  for (const entry of activeProxies.values()) {
    if (entry.clientId !== clientId) continue;
    const tunnel = entry.connections.get(connectionId);
    if (!tunnel) return;

    if (ok) {
      tunnel.connected = true;
      tunnel.socket.data.phaseDeadline = 0;
      tunnel.socket.timeout(SOCKS_PROXY_IDLE_TIMEOUT_SECONDS);
      // send SOCKS5 success response
      //  VER | REP | RSV | ATYP | BND.ADDR (4 bytes)  | BND.PORT (2 bytes)
      tunnel.socket.write(
        Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
      );
      logger.debug(`[socks5] tunnel established (conn=${connectionId})`);
      // flush any data that arrived between handshake and connect
      for (const buf of tunnel.pendingData) {
        sendDataToAgent(entry.clientId, connectionId, buf);
      }
      tunnel.pendingData = [];
      tunnel.pendingDataBytes = 0;
    } else {
      logger.debug(`[socks5] tunnel rejected by agent (conn=${connectionId})`);
      // SOCKS5 connection-refused reply
      tunnel.socket.write(
        Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
      );
      tunnel.socket.end();
      entry.connections.delete(connectionId);
    }
    return;
  }
}

function handleSocksData(
  socket: Socket<ProxySocketData>,
  incoming: Buffer,
  entry: ProxyEntry,
) {
  const { connectionId, phase } = socket.data;
  const tunnel = entry.connections.get(connectionId);
  const waitingForSetup = phase !== "tunneling" || !tunnel?.connected;
  if (waitingForSetup && Date.now() >= socket.data.phaseDeadline) {
    if (tunnel) closeTunnel(entry, tunnel, "handshake/connect deadline exceeded");
    else socket.end();
    return;
  }
  if (waitingForSetup) {
    const remainingSeconds = Math.max(
      1,
      Math.ceil((socket.data.phaseDeadline - Date.now()) / 1000),
    );
    socket.timeout(remainingSeconds);
  } else {
    socket.timeout(SOCKS_PROXY_IDLE_TIMEOUT_SECONDS);
  }

  if (phase === "tunneling") {
    if (!tunnel) {
      socket.end();
      return;
    }
    if (!tunnel.connected) {
      const nextBytes = enqueueSocksBuffer(
        tunnel.pendingData,
        tunnel.pendingDataBytes,
        incoming,
        SOCKS_PROXY_MAX_PENDING_BYTES,
      );
      if (nextBytes === null) {
        closeTunnelForBufferOverflow(entry, tunnel, "pending");
        return;
      }
      tunnel.pendingDataBytes = nextBytes;
      return;
    }
    sendDataToAgent(entry.clientId, connectionId, incoming);
    return;
  }

  if (socket.data.buffer.byteLength + incoming.byteLength > SOCKS_PROXY_MAX_HANDSHAKE_BYTES) {
    const tunnel = entry.connections.get(connectionId);
    if (tunnel) {
      closeTunnelForBufferOverflow(entry, tunnel, "pending");
    } else {
      socket.end();
    }
    return;
  }
  socket.data.buffer = Buffer.concat([socket.data.buffer, incoming]);
  const buf = socket.data.buffer;

  if (phase === "greeting") {
    if (buf.length < 2) return;
    const ver = buf[0];
    const nmethods = buf[1];
    if (ver !== 5) {
      socket.end();
      entry.connections.delete(connectionId);
      return;
    }
    if (buf.length < 2 + nmethods) return;

    const methods = buf.subarray(2, 2 + nmethods);
    if (!methods.includes(0x00)) {
      socket.write(Buffer.from([0x05, 0xff]));
      socket.end();
      entry.connections.delete(connectionId);
      return;
    }

    socket.write(Buffer.from([0x05, 0x00]));
    socket.data.phase = "request";
    socket.data.buffer = buf.subarray(2 + nmethods);

    if (socket.data.buffer.length > 0) {
      handleSocksData(socket, Buffer.alloc(0), entry);
    }
    return;
  }

  if (phase === "request") {
    if (buf.length < 4) return;
    const ver = buf[0];
    const cmd = buf[1];
    const atyp = buf[3];

    if (ver !== 5) {
      socket.end();
      entry.connections.delete(connectionId);
      return;
    }
    if (cmd !== 1) {
      socket.write(
        Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
      );
      socket.end();
      entry.connections.delete(connectionId);
      return;
    }

    let host: string;
    let portOffset: number;

    switch (atyp) {
      case 1: {
        if (buf.length < 10) return;
        host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
        portOffset = 8;
        break;
      }
      case 3: {
        if (buf.length < 5) return;
        const domainLen = buf[4];
        if (buf.length < 5 + domainLen + 2) return;
        host = buf.subarray(5, 5 + domainLen).toString("utf8");
        portOffset = 5 + domainLen;
        break;
      }
      case 4: {
        if (buf.length < 22) return;
        const parts: string[] = [];
        for (let i = 0; i < 16; i += 2) {
          parts.push(buf.readUInt16BE(4 + i).toString(16));
        }
        host = parts.join(":");
        portOffset = 20;
        break;
      }
      default: {
        socket.write(
          Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
        );
        socket.end();
        entry.connections.delete(connectionId);
        return;
      }
    }

    const port = buf.readUInt16BE(portOffset);
    logger.debug(
      `[socks5] CONNECT request → ${host}:${port} (conn=${connectionId})`,
    );

    socket.data.phase = "tunneling";
    socket.data.buffer = Buffer.alloc(0);
    socket.data.phaseDeadline = Date.now() + SOCKS_PROXY_CONNECT_TIMEOUT_SECONDS * 1000;
    socket.timeout(SOCKS_PROXY_CONNECT_TIMEOUT_SECONDS);

    const agent = clientManager.getClient(entry.clientId);
    if (!agent) {
      socket.write(
        Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
      );
      socket.end();
      entry.connections.delete(connectionId);
      return;
    }

    try {
      agent.ws.send(
        encodeMessage({
          type: "command",
          commandType: "proxy_connect",
          id: connectionId,
          payload: { host, port },
        } as any),
      );
    } catch {
      const activeTunnel = entry.connections.get(connectionId);
      if (activeTunnel) closeTunnel(entry, activeTunnel, "failed to contact agent");
      return;
    }

    const remaining = buf.subarray(portOffset + 2);
    if (remaining.length > 0) {
      const tunnel = entry.connections.get(connectionId);
      if (tunnel) {
        const nextBytes = enqueueSocksBuffer(
          tunnel.pendingData,
          tunnel.pendingDataBytes,
          remaining,
          SOCKS_PROXY_MAX_PENDING_BYTES,
        );
        if (nextBytes === null) {
          closeTunnelForBufferOverflow(entry, tunnel, "pending");
          return;
        }
        tunnel.pendingDataBytes = nextBytes;
      }
    }
    return;
  }
}

function sendDataToAgent(
  clientId: string,
  connectionId: string,
  data: Buffer | Uint8Array,
): void {
  const agent = clientManager.getClient(clientId);
  if (!agent) return;
  try {
    agent.ws.send(
      encodeMessage({
        type: "command",
        commandType: "proxy_data",
        id: connectionId,
        payload: { data: new Uint8Array(data) },
      } as any),
    );
  } catch (err) {
    logger.error(`[socks5] failed to send data to agent ${clientId}`, err);
  }
}
