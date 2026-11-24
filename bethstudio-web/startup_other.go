//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var processStart = time.Now()

func sinceStart() string { return time.Since(processStart).String() }

// claimSingleStudio: one Studio window. A second launch asks the first to
// come forward (it polls studio.focus) and exits. The pid file is the lock.
func claimSingleStudio() bool {
	path := studioPIDFile()
	if path == "" {
		return true
	}
	if b, err := os.ReadFile(path); err == nil {
		pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
		if pid > 0 && pid != os.Getpid() && processAlive(pid) {
			_ = os.WriteFile(studioFocusFile(), []byte("focus\n"), 0o644)
			return false
		}
	}
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	if err := os.WriteFile(path, []byte(strconv.Itoa(os.Getpid())), 0o644); err != nil {
		return true
	}
	return true
}

func studioPIDFile() string {
	dir := dataDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "studio.pid")
}

func studioFocusFile() string {
	dir := dataDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "studio.focus")
}

func releaseStudioClaim() {
	path := studioPIDFile()
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	if pid == os.Getpid() {
		_ = os.Remove(path)
	}
}

// focusWatcher brings the native window forward when a second launch writes
// studio.focus. Wired by the macOS window.
var bringStudioForward func()

func watchStudioFocus() {
	path := studioFocusFile()
	if path == "" {
		return
	}
	_ = os.Remove(path)
	go func() {
		for {
			time.Sleep(400 * time.Millisecond)
			if _, err := os.Stat(path); err != nil {
				continue
			}
			_ = os.Remove(path)
			if bringStudioForward != nil {
				bringStudioForward()
			}
		}
	}()
}

// silence unused on platforms that never signal.
var _ = syscall.SIGTERM
