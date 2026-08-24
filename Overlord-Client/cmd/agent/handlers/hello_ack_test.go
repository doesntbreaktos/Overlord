package handlers

import (
	"context"
	"testing"

	"overlord-client/cmd/agent/config"
	"overlord-client/cmd/agent/plugins"
	agentRuntime "overlord-client/cmd/agent/runtime"
)

func TestHandleHelloAckAdoptsCanonicalClientID(t *testing.T) {
	writer := &testWriter{}
	env := &agentRuntime.Env{
		Conn: writer,
		Cfg:  config.Config{ID: "claimed-client-id"},
	}
	env.Plugins = plugins.NewManager(writer, plugins.HostInfo{ClientID: env.ClientID()})

	if err := HandleHelloAck(context.Background(), env, map[string]interface{}{
		"id":              "key-fingerprint-canonical-id",
		"protocolVersion": 1,
	}); err != nil {
		t.Fatalf("HandleHelloAck failed: %v", err)
	}

	if got := env.ClientID(); got != "key-fingerprint-canonical-id" {
		t.Fatalf("runtime client id = %q, want canonical id", got)
	}
	if got := env.Plugins.ClientID(); got != "key-fingerprint-canonical-id" {
		t.Fatalf("plugin host client id = %q, want canonical id", got)
	}
}

func TestHandleHelloAckWithoutIDRetainsConfiguredFallback(t *testing.T) {
	env := &agentRuntime.Env{Cfg: config.Config{ID: "claimed-client-id"}}
	if err := HandleHelloAck(context.Background(), env, map[string]interface{}{
		"protocolVersion": 1,
	}); err != nil {
		t.Fatalf("HandleHelloAck failed: %v", err)
	}
	if got := env.ClientID(); got != "claimed-client-id" {
		t.Fatalf("legacy hello_ack client id = %q, want configured fallback", got)
	}
}
