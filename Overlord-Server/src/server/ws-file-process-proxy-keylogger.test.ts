import { describe, expect, test } from "bun:test";
import {
  handleFileBrowserMessage,
  MAX_FILE_LIST_ENTRIES,
  MAX_KEYLOG_CONTENT_BYTES,
  MAX_PROCESS_ICON_ITEMS,
  normalizeFileBrowserAgentMessage,
  normalizeKeyloggerAgentMessage,
  normalizeProcessAgentMessage,
} from "./ws-file-process-proxy-keylogger";

describe("file browser agent download routing", () => {
  test("only consumes pending HTTP downloads for the matching client", () => {
    let consumed = 0;
    const payload = { type: "file_download", commandId: "download-1", data: new Uint8Array([1]) };
    const deps = {
      pendingHttpDownloads: new Map([["download-1", { clientId: "client-a" }]]),
      consumeHttpDownloadPayload: () => { consumed += 1; },
    };

    handleFileBrowserMessage("client-b", payload, deps);
    expect(consumed).toBe(0);

    handleFileBrowserMessage("client-a", payload, deps);
    expect(consumed).toBe(1);
  });

  test("drops unsolicited download payloads", () => {
    let consumed = 0;
    handleFileBrowserMessage(
      "client-a",
      { type: "file_download", commandId: "unknown", data: new Uint8Array([1]) },
      {
        pendingHttpDownloads: new Map(),
        consumeHttpDownloadPayload: () => { consumed += 1; },
      },
    );
    expect(consumed).toBe(0);
  });
});

describe("agent result relay normalization", () => {
  test("bounds file lists and removes unrecognized attacker fields", () => {
    const normalized = normalizeFileBrowserAgentMessage({
      type: "file_list_result",
      commandId: "command",
      path: "/tmp",
      junk: "not relayed",
      entries: Array.from({ length: MAX_FILE_LIST_ENTRIES + 5 }, (_, index) => ({
        name: `file-${index}`,
        path: `/tmp/file-${index}`,
        size: index,
      })),
    }) as any;

    expect(normalized.entries).toHaveLength(MAX_FILE_LIST_ENTRIES);
    expect(normalized.junk).toBeUndefined();
  });

  test("strictly rejects scalar process icon data and caps item counts", () => {
    const normalized = normalizeProcessAgentMessage({
      type: "process_icon_result",
      junk: "not relayed",
      icons: Array.from({ length: MAX_PROCESS_ICON_ITEMS + 5 }, (_, index) => ({
        key: `icon-${index}`,
        png: index === 0 ? 0xffff_ffff : new Uint8Array([index]),
      })),
    }) as any;

    expect(normalized.icons).toHaveLength(MAX_PROCESS_ICON_ITEMS);
    expect(normalized.icons[0].png).toBeUndefined();
    expect(normalized.junk).toBeUndefined();
  });

  test("drops oversized keylog content before viewer fan-out", () => {
    expect(normalizeKeyloggerAgentMessage({
      type: "keylog_file_content",
      filename: "today.log",
      content: "x".repeat(MAX_KEYLOG_CONTENT_BYTES + 1),
    })).toBeNull();
  });
});
