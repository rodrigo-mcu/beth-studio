//go:build windows

package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

func launchSFTPWindow(hostID string) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(self); err == nil {
		self = resolved
	}
	cmd := exec.Command(self, "--sftp", hostID)
	cmd.Dir = filepath.Dir(self)
	allowForeground()
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x08000000 | 0x00000008 | 0x00000200,
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("não foi possível abrir a janela SFTP: %w", err)
	}
	go func() { _ = cmd.Wait() }()
	log.Printf("sftp: janela aberta para host %s (pid %d)", hostID, cmd.Process.Pid)
	return nil
}
