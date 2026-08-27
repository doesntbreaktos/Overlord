//go:build !builder_release

package overlordenv

import "testing"

func TestGetenvReadsDevelopmentOverride(t *testing.T) {
	t.Setenv("OVERLORD_TEST_ONLY", "enabled")
	if got := Getenv("OVERLORD_TEST_ONLY"); got != "enabled" {
		t.Fatalf("Getenv() = %q, want %q", got, "enabled")
	}
}
