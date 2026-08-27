//go:build builder_release

package handlers

import "time"

func streamInterval(_ string, defFPS int) (time.Duration, int) {
	fps := defFPS
	if fps < 1 {
		fps = 1
	}
	if fps > 1000 {
		fps = 1000
	}
	return time.Second / time.Duration(fps), fps
}
