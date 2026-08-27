package wire

import "testing"

func TestGeneratedWireContract(t *testing.T) {
	if WireProtocolVersion != 1 {
		t.Fatalf("unexpected wire protocol version: %d", WireProtocolVersion)
	}
	if len(CommandTypes) != 144 {
		t.Fatalf("unexpected command count: %d", len(CommandTypes))
	}
	if len(CommandVersionSupport) != len(CommandTypes) {
		t.Fatalf("command version catalog has %d entries, want %d", len(CommandVersionSupport), len(CommandTypes))
	}
	for _, command := range CommandTypes {
		versionRange, ok := CommandVersionSupport[command]
		if !ok {
			t.Fatalf("missing version range for %s", command)
		}
		wantMin, wantMax := 1, 1
		switch command {
		case CommandBackstageStartBrowserInjected, CommandBackstageStartChromeInjected, CommandBackstageStartProcessInjected:
			wantMin, wantMax = 2, 3
		}
		if versionRange.Min != wantMin || versionRange.Max != wantMax {
			t.Fatalf("unexpected version range for %s: %+v", command, versionRange)
		}
		if IsSupportedCommandVersion(string(command), 1) != (wantMin == 1) {
			t.Fatalf("unexpected v1 support for %s", command)
		}
		if IsSupportedCommandVersion(string(command), 2) != (wantMin <= 2 && wantMax >= 2) {
			t.Fatalf("unexpected v2 support for %s", command)
		}
		if IsSupportedCommandVersion(string(command), 3) != (wantMin <= 3 && wantMax >= 3) {
			t.Fatalf("unexpected v3 support for %s", command)
		}
	}
	if !IsCommandType("desktop_start") {
		t.Fatal("desktop_start must be a known command")
	}
	if !IsCommandType("virtual_window_list") {
		t.Fatal("virtual_window_list must be a known command")
	}
	if !IsCommandType("file_upload_desktop") {
		t.Fatal("file_upload_desktop must be a known command")
	}
	if !IsCommandType("clipboard_get") {
		t.Fatal("clipboard_get must be a known command")
	}
	if IsCommandType("not_a_command") {
		t.Fatal("unknown command was accepted")
	}
	if !IsServerToAgentMessageType("hello_ack") {
		t.Fatal("hello_ack must be a known server message")
	}
	if IsServerToAgentMessageType("console_output") {
		t.Fatal("agent-only message was accepted as a server message")
	}
}
