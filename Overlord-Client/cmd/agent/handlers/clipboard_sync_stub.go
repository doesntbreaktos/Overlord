//go:build !windows

package handlers

import (
	"context"

	"overlord-client/cmd/agent/runtime"
)

func ClipboardSyncStart(_ context.Context, _ *runtime.Env, _ string)     {}
func ClipboardSyncGet(_ context.Context, _ *runtime.Env, _ string) error { return nil }
func ClipboardSyncSet(_ context.Context, _ string) error                 { return nil }
