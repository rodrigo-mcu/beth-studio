//go:build darwin

package main

// hostctl_darwin.go — the same supervisor contract as Windows, without a
// named mutex. The host (patch 0205) holds `host.lock` with flock for as
// long as it lives and exits when `host.quit` appears. The Studio starts
// `bethstudio-host` next to itself, waits for the socket, and only asks it
// to quit after the user confirms "Encerrar tudo".

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type realHostCtl struct{}

func newHostCtl() hostCtl { return realHostCtl{} }

func (realHostCtl) Running() bool {
	return hostLockHeld(hostLockPath())
}

func (c realHostCtl) Start() error {
	if c.Running() {
		return nil
	}
	exe, err := hostExePath()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe)
	cmd.Dir = filepath.Dir(exe)
	cmd.Env = append(os.Environ(), "BETHSTUDIO_ACTIVE=1", "WTINATOR_ACTIVE=1")
	if id := hostID(); id != "" {
		cmd.Env = append(cmd.Env, "BETHSTUDIO_HOST_ID="+id)
	}
	if err := launchDetached(cmd); err != nil {
		return fmt.Errorf("não foi possível iniciar o host: %w", err)
	}
	pid := cmd.Process.Pid
	go func() { _ = cmd.Wait() }()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if c.Running() {
			if _, err := os.Stat(hostSockPath()); err == nil {
				log.Printf("host: iniciado pelo Studio (pid %d)", pid)
				return nil
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("o host (pid %d) não ficou pronto em 8 s", pid)
}

func (c realHostCtl) RequestQuit(requester string) error {
	exe, _ := os.Executable()
	_ = os.MkdirAll(filepath.Dir(quitRequestPath()), 0o755)
	_ = os.WriteFile(quitRequestPath(), []byte(quitRequestText(time.Now(), os.Getpid(), exe, requester)), 0o644)
	if err := os.WriteFile(hostQuitPath(), []byte("quit\n"), 0o644); err != nil {
		return err
	}
	for i := 0; i < 50; i++ {
		if !c.Running() {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return c.terminateByPidFile()
}

func (c realHostCtl) terminateByPidFile() error {
	b, err := os.ReadFile(hostPidPath())
	if err != nil {
		return fmt.Errorf("o host não saiu e não há host.pid: %w", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		return err
	}
	if !processAlive(pid) {
		return nil
	}
	lifeLog(fmt.Sprintf("o host não saiu em 5 s; encerrando o pid %d a pedido do usuário", pid))
	return terminatePID(pid)
}

func (realHostCtl) GUIRunning() bool { return false }

func hostLockPath() string { return hostFile("lock") }
func hostQuitPath() string { return hostFile("quit") }
