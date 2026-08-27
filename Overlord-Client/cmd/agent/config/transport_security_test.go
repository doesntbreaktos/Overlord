//go:build !builder_release

package config

import "testing"

func TestTLSVerificationIsSecureByDefault(t *testing.T) {
	originalPins := DefaultTLSSPKIPins
	DefaultTLSSPKIPins = "pin-one,pin-two,pin-one"
	t.Cleanup(func() { DefaultTLSSPKIPins = originalPins })

	t.Setenv("OVERLORD_TLS_INSECURE_SKIP_VERIFY", "")
	t.Setenv("OVERLORD_TLS_SPKI_PINS", "")

	cfg := Load()
	if cfg.TLSInsecureSkipVerify {
		t.Fatal("TLS certificate verification must be enabled by default")
	}
	if len(cfg.TLSSPKIPins) != 2 || cfg.TLSSPKIPins[0] != "pin-one" || cfg.TLSSPKIPins[1] != "pin-two" {
		t.Fatalf("unexpected embedded TLS pins: %#v", cfg.TLSSPKIPins)
	}
}

func TestTLSInsecureModeRequiresExplicitOptIn(t *testing.T) {
	t.Setenv("OVERLORD_TLS_INSECURE_SKIP_VERIFY", "true")
	cfg := Load()
	if !cfg.TLSInsecureSkipVerify {
		t.Fatal("explicit development opt-out was not honored")
	}
}
