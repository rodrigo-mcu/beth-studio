package main

// wsl_ready.go — antes de abrir um terminal WSL, esperar o WSL ficar pronto:
// a distro respondendo e a pasta existindo. wsl.exe sobe a distro sozinho, mas
// na pressa de restaurar vários terminais ao mesmo tempo ele corre contra a
// VM fria: os que perdem a corrida fecham ou caem em "/". O comando de
// inicialização do usuário (init-wsl2) NÃO roda aqui: ele roda por um fluxo
// guiado, num terminal visível, na restauração (restore_init.go).

import (
	"context"
	"fmt"
	"strings"
	"time"
)

const (
	wslEnsureTimeout = 60 * time.Second
	wslDirTimeout    = 30 * time.Second
	wslCmdTimeout    = 20 * time.Second
)

// cmdRunner executa um programa sem janela, com limite de tempo.
type cmdRunner func(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error)

// wslDistroForShell: a distro de um shell WSL do Studio. Vazio se não dá para saber.
func wslDistroForShell(shellID, distro string, installed []string, def string) string {
	if distro != "" {
		return distro
	}
	if shellID == "wsl.default" {
		return def
	}
	name := strings.TrimPrefix(shellID, "wsl.")
	for _, d := range installed {
		if strings.EqualFold(d, name) {
			return d
		}
	}
	return ""
}

// spawnErrorWithRequest: mensagem no formato que a interface reconhece
// ("spawn x (request r1): ..."), para o terminal pendente falhar com o motivo.
func spawnErrorWithRequest(reqID string, err error) string {
	return fmt.Sprintf("spawn wsl (request %s): %v", reqID, err)
}

type wslGate struct {
	run   cmdRunner
	now   func() time.Time
	sleep func(time.Duration)
}

func newWSLGate(run cmdRunner) *wslGate {
	return &wslGate{run: run, now: time.Now, sleep: time.Sleep}
}

func (g *wslGate) running(ctx context.Context, distro string) bool {
	out, err := g.run(ctx, wslCmdTimeout, "wsl.exe", "-l", "--running", "-q")
	if err != nil {
		return false
	}
	for _, n := range parseWSLRunningNames(out) {
		if strings.EqualFold(n, distro) {
			return true
		}
	}
	return false
}

// BootID: identifica o boot da VM do WSL (muda quando ela reinicia); "" se não deu para ler.
func (g *wslGate) BootID(ctx context.Context, distro string) string {
	out, err := g.run(ctx, wslCmdTimeout, "wsl.exe", "-d", distro, "--exec", "cat", "/proc/sys/kernel/random/boot_id")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// Ensure deixa a distro rodando; err é fatal (a distro não subiu no prazo).
func (g *wslGate) Ensure(ctx context.Context, distro string) error {
	if g.running(ctx, distro) {
		return nil
	}
	deadline := g.now().Add(wslEnsureTimeout)
	wait := time.Second
	var last error
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if _, e := g.run(ctx, wslCmdTimeout, "wsl.exe", "-d", distro, "--exec", "true"); e == nil {
			return nil
		} else {
			last = e
		}
		if !g.now().Before(deadline) {
			return fmt.Errorf("a distro %s não respondeu em %d s: %v", distro, int(wslEnsureTimeout/time.Second), last)
		}
		g.sleep(wait)
		if wait < 5*time.Second {
			wait += time.Second
		}
	}
}

// DirExists confere uma vez, sem esperar, se a pasta Linux existe. Pasta vazia
// ou "~" conta como existente (não depende de montagem).
func (g *wslGate) DirExists(ctx context.Context, distro, path string) bool {
	if path == "" || path == "~" {
		return true
	}
	_, err := g.run(ctx, wslCmdTimeout, "wsl.exe", "-d", distro, "--exec", "test", "-d", path)
	return err == nil
}

// WaitDir espera a pasta Linux existir (até 30 s). Pasta vazia ou "~" não espera.
func (g *wslGate) WaitDir(ctx context.Context, distro, path string) bool {
	if path == "" || path == "~" {
		return true
	}
	deadline := g.now().Add(wslDirTimeout)
	for {
		if ctx.Err() != nil {
			return false
		}
		if _, err := g.run(ctx, wslCmdTimeout, "wsl.exe", "-d", distro, "--exec", "test", "-d", path); err == nil {
			return true
		}
		if !g.now().Before(deadline) {
			return false
		}
		g.sleep(time.Second)
	}
}
