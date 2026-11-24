//go:build !windows

package main

import (
	"fmt"
	"os/exec"
	"syscall"
)

// launchDetached starts a child in its own process group so closing the
// Studio window does not take the host (or a detached window) with it.
func launchDetached(cmd *exec.Cmd) error {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return cmd.Start()
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

func terminatePID(pid int) error {
	if pid <= 1 {
		return fmt.Errorf("pid inválido")
	}
	return syscall.Kill(pid, syscall.SIGTERM)
}
