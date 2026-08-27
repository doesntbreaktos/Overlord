//go:build builder_release

package handlers

import (
	"testing"
	"time"
)

func TestReleaseStreamIntervalIgnoresEnvironmentName(t *testing.T) {
	t.Setenv("OVERLORD_DESKTOP_MAX_FPS", "60")
	interval, fps := streamInterval("OVERLORD_DESKTOP_MAX_FPS", 30)
	if fps != 30 || interval != time.Second/30 {
		t.Fatalf("streamInterval() = (%v, %d), want (%v, 30)", interval, fps, time.Second/30)
	}
}
