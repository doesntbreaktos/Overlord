//go:build builder_release

package overlordenv

import "testing"

func TestGetenvIgnoresReleaseOverride(t *testing.T) {
	t.Setenv("OVERLORD_TEST_ONLY", "enabled")
	if got := Getenv("OVERLORD_TEST_ONLY"); got != "" {
		t.Fatalf("Getenv() = %q, want release environment to be ignored", got)
	}
}
