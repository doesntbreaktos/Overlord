package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"overlord-client/cmd/agent/config"
	"overlord-client/cmd/agent/plugins"
	agentRuntime "overlord-client/cmd/agent/runtime"
)

func TestHandlePluginLoadHTTPUsesCanonicalClientID(t *testing.T) {
	headers := make(chan http.Header, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers <- r.Header.Clone()
		http.Error(w, "stop after header assertion", http.StatusForbidden)
	}))
	defer server.Close()

	writer := &testWriter{}
	env := &agentRuntime.Env{
		Conn: writer,
		Cfg: config.Config{
			ID:                    "claimed-client-id",
			AgentToken:            "agent-token",
			TLSInsecureSkipVerify: true,
		},
	}
	env.Plugins = plugins.NewManager(writer, plugins.HostInfo{ClientID: env.ClientID()})
	if !env.SetServerClientID("key-fingerprint-canonical-id") {
		t.Fatal("failed to install canonical client id")
	}

	if err := HandlePluginLoadHTTP(
		context.Background(),
		env,
		"plugin-command-id",
		plugins.PluginManifest{ID: "test-plugin"},
		server.URL+"/api/plugins/pull/test-id",
		1,
	); err != nil {
		t.Fatalf("HandlePluginLoadHTTP failed: %v", err)
	}

	got := <-headers
	if clientID := got.Get("x-overlord-client-id"); clientID != "key-fingerprint-canonical-id" {
		t.Fatalf("plugin pull client id = %q, want canonical id", clientID)
	}
	if token := got.Get("x-agent-token"); token != "agent-token" {
		t.Fatalf("plugin pull token = %q, want agent token", token)
	}
}
