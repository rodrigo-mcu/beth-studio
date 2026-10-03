package main

// wsl_ready.go — antes de abrir um terminal WSL, esperar o WSL ficar pronto:
// a distro respondendo, o comando de inicialização opcional rodado (uma vez
// por boot da VM) e a pasta existindo. wsl.exe sobe a distro sozinho, mas na
// pressa de restaurar vários terminais ao mesmo tempo ele corre contra a
// VM fria: os que perdem a corrida fecham ou caem em "/".

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	wslEnsureTimeout = 60 * time.Second
	wslDirTimeout    = 30 * time.Second
	wslCmdTimeout    = 20 * time.Second
)

// cmdRunner executa um programa sem janela, com limite de tempo.
type cmdRunner func(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error)

// wslDistroCfg vem de %APPDATA%\bethterm\wsl-distros.json: o comando que
// algumas distros precisam depois de subir (serviços, montagens).
type wslDistroCfg struct {
	Init       string `json:"init"`
	User       string `json:"user"`
	TimeoutSec int    `json:"timeout_sec"`
}

// loadWSLDistroCfg lê wsl-distros.json de dir; a chave é o nome da distro em
// minúsculas. Arquivo ausente ou inválido dá um mapa vazio.
func loadWSLDistroCfg(dir string) map[string]wslDistroCfg {
	out := map[string]wslDistroCfg{}
	b, err := os.ReadFile(filepath.Join(dir, "wsl-distros.json"))
	if err != nil {
		return out
	}
	var raw map[string]wslDistroCfg
	if json.Unmarshal(b, &raw) != nil {
		return out
	}
	for k, v := range raw {
		out[strings.ToLower(strings.TrimSpace(k))] = v
	}
	return out
}

type wslGate struct {
	run   cmdRunner
	cfg   map[string]wslDistroCfg
	now   func() time.Time
	sleep func(time.Duration)

	mu       sync.Mutex
	initDone map[string]string // distro (minúscula) -> boot_id em que o init já rodou
}

func newWSLGate(run cmdRunner, cfg map[string]wslDistroCfg) *wslGate {
	return &wslGate{run: run, cfg: cfg, now: time.Now, sleep: time.Sleep, initDone: map[string]string{}}
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

func (g *wslGate) bootID(ctx context.Context, distro string) string {
	out, err := g.run(ctx, wslCmdTimeout, "wsl.exe", "-d", distro, "--exec", "cat", "/proc/sys/kernel/random/boot_id")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// Ensure deixa a distro rodando e o init (se houver) feito neste boot. err é
// fatal (a distro não subiu no prazo); initErr é só um aviso.
func (g *wslGate) Ensure(ctx context.Context, distro string) (initErr error, err error) {
	if !g.running(ctx, distro) {
		deadline := g.now().Add(wslEnsureTimeout)
		wait := time.Second
		var last error
		for {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if _, e := g.run(ctx, wslCmdTimeout, "wsl.exe", "-d", distro, "--exec", "true"); e == nil {
				break
			} else {
				last = e
			}
			if !g.now().Before(deadline) {
				return nil, fmt.Errorf("a distro %s não respondeu em %d s: %v", distro, int(wslEnsureTimeout/time.Second), last)
			}
			g.sleep(wait)
			if wait < 5*time.Second {
				wait += time.Second
			}
		}
	}
	key := strings.ToLower(distro)
	cfg, ok := g.cfg[key]
	if !ok || strings.TrimSpace(cfg.Init) == "" {
		return nil, nil
	}
	boot := g.bootID(ctx, distro)
	g.mu.Lock()
	done := boot != "" && g.initDone[key] == boot
	g.mu.Unlock()
	if done {
		return nil, nil
	}
	user := cfg.User
	if strings.TrimSpace(user) == "" {
		user = "root"
	}
	timeout := time.Duration(cfg.TimeoutSec) * time.Second
	if timeout <= 0 {
		timeout = wslEnsureTimeout
	}
	_, e := g.run(ctx, timeout, "wsl.exe", "-d", distro, "-u", user, "--exec", "sh", "-c", cfg.Init)
	g.mu.Lock()
	g.initDone[key] = boot // mesmo com falha: não repete a cada terminal
	g.mu.Unlock()
	if e != nil {
		return fmt.Errorf("o comando de inicialização de %s falhou: %v", distro, e), nil
	}
	return nil, nil
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
