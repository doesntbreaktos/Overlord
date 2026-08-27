//go:build !builder_release

package handlers

import (
	"log"
	"strconv"
	"strings"
	"time"

	"overlord-client/cmd/agent/internal/overlordenv"
)

func streamInterval(envVar string, defFPS int) (time.Duration, int) {
	fps := defFPS
	raw := strings.TrimSpace(overlordenv.Getenv(envVar))
	if raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v > 0 {
			fps = v
		} else {
			log.Printf("stream: invalid development FPS override %q, using %d", raw, defFPS)
		}
	}
	if fps < 1 {
		fps = 1
	}
	if fps > 1000 {
		fps = 1000
	}
	return time.Second / time.Duration(fps), fps
}
