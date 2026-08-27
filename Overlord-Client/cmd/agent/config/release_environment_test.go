//go:build builder_release

package config

import (
	"testing"
	"time"
)

func TestReleaseBuildIgnoresRuntimeEnvironmentOverrides(t *testing.T) {
	t.Setenv("OVERLORD_SERVER", "wss://environment.invalid:9999")
	t.Setenv("OVERLORD_CAPTURE_INTERVAL", "1ms")
	t.Setenv("OVERLORD_TLS_INSECURE_SKIP_VERIFY", "true")

	cfg := Load()
	if len(cfg.ServerURLs) != 1 || cfg.ServerURLs[0] != DefaultServerURL {
		t.Fatalf("ServerURLs = %v, want embedded default %q", cfg.ServerURLs, DefaultServerURL)
	}
	if cfg.CaptureInterval != 20*time.Second {
		t.Fatalf("CaptureInterval = %v, want 20s", cfg.CaptureInterval)
	}
	if cfg.TLSInsecureSkipVerify {
		t.Fatal("release build honored OVERLORD_TLS_INSECURE_SKIP_VERIFY")
	}
}
