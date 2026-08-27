import { describe, expect, test } from "bun:test";
import {
  AGENT_TO_SERVER_MESSAGE_TYPES,
  COMMAND_TYPES,
  COMMAND_VERSION_SUPPORT,
  WIRE_PROTOCOL_VERSION,
  getImplicitCommandVersion,
  isAgentToServerMessageType,
  isCommandType,
  isSupportedCommandVersion,
} from "./generated/wire-contract";
import {
  ALLOWED_CLIENT_MESSAGE_TYPES,
  isAllowedClientMessageType,
} from "./wsValidation";

describe("generated wire protocol contract", () => {
  test("publishes the complete command catalog", () => {
    expect(WIRE_PROTOCOL_VERSION).toBe(1);
    expect(COMMAND_TYPES.length).toBe(144);
    expect(new Set(COMMAND_TYPES).size).toBe(COMMAND_TYPES.length);
    expect(isCommandType("desktop_start")).toBe(true);
    expect(isCommandType("file_upload_desktop")).toBe(true);
    expect(isCommandType("virtual_window_list")).toBe(true);
    expect(isCommandType("not_a_command")).toBe(false);
  });

  test("publishes a version range for every command", () => {
    const versionedBackstageCommands = new Set([
      "backstage_start_browser_injected",
      "backstage_start_chrome_injected",
      "backstage_start_process_injected",
    ]);
    expect(Object.keys(COMMAND_VERSION_SUPPORT).length).toBe(COMMAND_TYPES.length);
    for (const command of COMMAND_TYPES) {
      const isVersioned = versionedBackstageCommands.has(command);
      expect(COMMAND_VERSION_SUPPORT[command].min).toBe(isVersioned ? 2 : 1);
      expect(COMMAND_VERSION_SUPPORT[command].max).toBe(isVersioned ? 3 : 1);
      expect(isSupportedCommandVersion(command, 1)).toBe(!isVersioned);
      expect(isSupportedCommandVersion(command, 2)).toBe(isVersioned);
      expect(isSupportedCommandVersion(command, 3)).toBe(isVersioned);
      if (isVersioned) {
        expect(() => getImplicitCommandVersion(command)).toThrow("explicit commandVersion");
      } else {
        expect(getImplicitCommandVersion(command)).toBe(1);
      }
    }
  });

  test("drives the inbound client allowlist", () => {
    expect([...ALLOWED_CLIENT_MESSAGE_TYPES].sort()).toEqual(
      [...AGENT_TO_SERVER_MESSAGE_TYPES].sort(),
    );
    expect(isAgentToServerMessageType("hello")).toBe(true);
    expect(isAllowedClientMessageType("hello")).toBe(true);
    expect(isAllowedClientMessageType("hello_ack")).toBe(false);
  });
});
