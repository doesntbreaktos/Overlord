import { afterEach, describe, expect, test } from "bun:test";
import * as sessionManager from "../sessions/sessionManager";
import { handleDesktopAudioUplink } from "./ws-desktop-audio";
import { handleVoiceUplink } from "./ws-voice";

const voiceSessionIds: string[] = [];
const desktopAudioSessionIds: string[] = [];

function mockViewer() {
  const sent: unknown[] = [];
  return {
    sent,
    socket: {
      data: {},
      getBufferedAmount: () => 0,
      send: (value: unknown) => { sent.push(value); },
    } as any,
  };
}

afterEach(() => {
  for (const id of voiceSessionIds.splice(0)) sessionManager.deleteVoiceSession(id);
  for (const id of desktopAudioSessionIds.splice(0)) sessionManager.deleteDesktopAudioSession(id);
});

describe("legacy audio uplink routing", () => {
  test("broadcasts voice data without a sessionId and preserves an exact subview", () => {
    const clientId = `voice-relay-${Date.now().toString(36)}`;
    const first = mockViewer();
    const second = mockViewer();
    for (const [id, viewer] of [["voice-a", first], ["voice-b", second]] as const) {
      voiceSessionIds.push(id);
      sessionManager.addVoiceSession({ id, clientId, viewer: viewer.socket, createdAt: Date.now() });
    }

    const backing = new Uint8Array([9, 1, 2, 3, 8]);
    handleVoiceUplink(clientId, { data: new DataView(backing.buffer, 1, 3) });

    expect(Array.from(first.sent[0] as Uint8Array)).toEqual([1, 2, 3]);
    expect(Array.from(second.sent[0] as Uint8Array)).toEqual([1, 2, 3]);
  });

  test("broadcasts desktop audio without a sessionId but routes a supplied ID", () => {
    const clientId = `desktop-audio-relay-${Date.now().toString(36)}`;
    const first = mockViewer();
    const second = mockViewer();
    for (const [id, viewer] of [["audio-a", first], ["audio-b", second]] as const) {
      desktopAudioSessionIds.push(id);
      sessionManager.addDesktopAudioSession({ id, clientId, viewer: viewer.socket, createdAt: Date.now() });
    }

    handleDesktopAudioUplink(clientId, { data: new Uint8Array([1]) });
    handleDesktopAudioUplink(clientId, { sessionId: "audio-a", data: new Uint8Array([2]) });

    expect(first.sent.map((value) => Array.from(value as Uint8Array))).toEqual([[1], [2]]);
    expect(second.sent.map((value) => Array.from(value as Uint8Array))).toEqual([[1]]);
  });
});
