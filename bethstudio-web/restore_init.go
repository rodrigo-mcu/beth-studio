package main

// restore_init.go — o init do WSL na restauração: a pergunta ao usuário e o
// terminal de inicialização. O usuário digita o comando (init-wsl2) num
// terminal WSL de verdade, então UAC, senha, PATH e alias funcionam como
// sempre; o Studio só digita por ele e espera. O fim é detectado por um
// arquivo marcador na própria distro, que o shell grava com o código de saída.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	initPollEvery      = 2 * time.Second
	initNeverSeenAfter = 15 * time.Second // o terminal nunca apareceu na lista: conta como fechado
)

// initMarkerPath: o arquivo em que o shell grava o código de saída do init. O
// boot id vem de dentro da distro: só letras, números, ponto, hífen e sublinhado entram no caminho.
func initMarkerPath(bootID string) string {
	var b strings.Builder
	for _, r := range bootID {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	id := b.String()
	if id == "" {
		id = "nb"
	}
	return "/tmp/.bethstudio-init-" + id
}

// initTypedLine: o que o Studio digita no terminal (Enter incluído).
func initTypedLine(cmd, marker string) string {
	return cmd + "; echo $? > " + marker + "\r"
}

// pollInitMarker lê o marcador na distro: ok=false enquanto ele não existe (ou não é um número).
func pollInitMarker(ctx context.Context, run cmdRunner, distro, marker string) (code int, ok bool) {
	out, err := run(ctx, wslCmdTimeout, "wsl.exe", "-d", distro, "--exec", "cat", marker)
	if err != nil {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		return 0, false
	}
	return n, true
}

// initTerm: o que runInitTerminal precisa do mundo de fora (trocado nos testes).
type initTerm interface {
	Open(ctx context.Context, distro string) (pane int, err error) // terminal WSL visível, na home
	Send(pane int, data string) error                              // digita no terminal
	Alive(pane int) bool                                           // o terminal ainda está na lista viva do host
	Kill(pane int)
	Run(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error)
	Now() time.Time
	Sleep(d time.Duration)
	Skip() <-chan struct{} // "Continuar assim mesmo"
}

// runInitTerminal abre o terminal de inicialização, digita o comando e espera:
// marcador com o código de saída, o usuário fechar o terminal, "continuar
// assim mesmo" ou o tempo máximo. Código 0 fecha o terminal; erro ou tempo
// esgotado o deixam aberto para o usuário ver o que houve.
func runInitTerminal(ctx context.Context, t initTerm, distro, bootID string, cfg WSLInitCfg, tick func(elapsed time.Duration)) initOutcome {
	marker := initMarkerPath(bootID)
	_, _ = t.Run(ctx, wslCmdTimeout, "wsl.exe", "-d", distro, "--exec", "rm", "-f", marker)
	pane, err := t.Open(ctx, distro)
	if err != nil {
		return initOutcome{Err: fmt.Sprintf("não foi possível abrir o terminal de inicialização: %v", err)}
	}
	if err := t.Send(pane, initTypedLine(cfg.Command, marker)); err != nil {
		return initOutcome{Err: fmt.Sprintf("não foi possível digitar o comando no terminal: %v", err)}
	}
	timeout := time.Duration(cfg.TimeoutSec) * time.Second
	if timeout <= 0 {
		timeout = wslInitDefaultTimeoutSec * time.Second
	}
	start := t.Now()
	deadline := start.Add(timeout)
	seenAlive := false
	for {
		if ctx.Err() != nil {
			return initOutcome{Ran: true, Err: "cancelado"}
		}
		if code, ok := pollInitMarker(ctx, t.Run, distro, marker); ok {
			if code == 0 {
				t.Kill(pane)
				return initOutcome{Ran: true}
			}
			return initOutcome{Ran: true, ExitCode: code, Err: fmt.Sprintf("o comando saiu com código %d", code)}
		}
		select {
		case <-t.Skip():
			return initOutcome{Ran: true}
		default:
		}
		if t.Alive(pane) {
			seenAlive = true
		} else if seenAlive || t.Now().Sub(start) > initNeverSeenAfter {
			return initOutcome{Ran: true, ClosedByUser: true}
		}
		if !t.Now().Before(deadline) {
			return initOutcome{Ran: true, TimedOut: true}
		}
		if tick != nil {
			tick(t.Now().Sub(start))
		}
		t.Sleep(initPollEvery)
	}
}

// --- o hub: pergunta por canal e "continuar assim mesmo" ---

func lowerKey(distro string) string { return strings.ToLower(distro) }

// awaitInitAnswer registra a pergunta aberta da distro e devolve o canal da resposta.
func (h *hub) awaitInitAnswer(distro string) chan bool {
	ch := make(chan bool, 1)
	h.mu.Lock()
	if h.initAsk == nil {
		h.initAsk = map[string]chan bool{}
	}
	h.initAsk[lowerKey(distro)] = ch
	h.mu.Unlock()
	return ch
}

func (h *hub) dropInitAnswer(distro string) {
	h.mu.Lock()
	delete(h.initAsk, lowerKey(distro))
	h.mu.Unlock()
}

// answerInit entrega a resposta; false se não há pergunta aberta (ou já foi respondida).
func (h *hub) answerInit(distro string, run bool) bool {
	h.mu.Lock()
	ch := h.initAsk[lowerKey(distro)]
	delete(h.initAsk, lowerKey(distro))
	h.mu.Unlock()
	if ch == nil {
		return false
	}
	select {
	case ch <- run:
	default:
	}
	return true
}

// awaitInitSkip registra o init em andamento e devolve o canal de "continuar assim mesmo".
func (h *hub) awaitInitSkip(distro string) chan struct{} {
	ch := make(chan struct{})
	h.mu.Lock()
	if h.initSkip == nil {
		h.initSkip = map[string]chan struct{}{}
	}
	h.initSkip[lowerKey(distro)] = ch
	h.mu.Unlock()
	return ch
}

func (h *hub) dropInitSkip(distro string) {
	h.mu.Lock()
	delete(h.initSkip, lowerKey(distro))
	h.mu.Unlock()
}

// skipInit: "continuar assim mesmo" durante o init; false se não há init em andamento.
func (h *hub) skipInit(distro string) bool {
	h.mu.Lock()
	ch := h.initSkip[lowerKey(distro)]
	delete(h.initSkip, lowerKey(distro))
	h.mu.Unlock()
	if ch == nil {
		return false
	}
	close(ch)
	return true
}

// restoreAnswerHandler: POST /api/restore/answer {"distro","action":"run"|"skip"|"continue"}.
func restoreAnswerHandler(h *hub, readOnly bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
			return
		}
		if readOnly {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "modo somente leitura"})
			return
		}
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			http.Error(w, "use application/json", http.StatusUnsupportedMediaType)
			return
		}
		var req struct {
			Distro string `json:"distro"`
			Action string `json:"action"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil || !distroRe.MatchString(req.Distro) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
			return
		}
		var found bool
		switch req.Action {
		case "run":
			found = h.answerInit(req.Distro, true)
		case "skip":
			found = h.answerInit(req.Distro, false)
		case "continue":
			found = h.skipInit(req.Distro)
		default:
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "ação inválida"})
			return
		}
		if !found {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "não há pergunta nem init em andamento para essa distro"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
}

// --- o restoreEnv de verdade: pergunta e terminal pela bridge ---

// AskInit: o banner pergunta; a resposta chega por POST /api/restore/answer.
func (e *hubRestoreEnv) AskInit(ctx context.Context, distro string, missing []string) (bool, error) {
	ch := e.h.awaitInitAnswer(distro)
	defer e.h.dropInitAnswer(distro)
	select {
	case run := <-ch:
		return run, nil
	case <-ctx.Done():
		return false, ctx.Err()
	}
}

// initTestBoot: o "Testar agora" usa um marcador próprio, para não cruzar com uma restauração em curso.
func initTestBoot(boot string) string { return boot + "-test" }

// TestInit é o "Testar agora" das Configurações: o mesmo terminal de inicialização,
// sem andamento no banner da restauração e sem o "continuar assim mesmo" dela.
func (e *hubRestoreEnv) TestInit(ctx context.Context, distro string, cfg WSLInitCfg) initOutcome {
	boot := ""
	if g := e.h.wslGate; g != nil {
		boot = g.BootID(ctx, distro)
	}
	return runInitTerminal(ctx, &hubInitTerm{e: e, skip: make(chan struct{})}, distro, initTestBoot(boot), cfg, nil)
}

// RunInit roda o init num terminal visível e espera terminar.
func (e *hubRestoreEnv) RunInit(ctx context.Context, distro string, cfg WSLInitCfg) initOutcome {
	boot := ""
	if g := e.h.wslGate; g != nil {
		boot = g.BootID(ctx, distro)
	}
	skip := e.h.awaitInitSkip(distro)
	defer e.h.dropInitSkip(distro)
	start := time.Now()
	lifeLog(fmt.Sprintf("init do WSL (%s): iniciado", distro))
	out := runInitTerminal(ctx, &hubInitTerm{e: e, skip: skip}, distro, boot, cfg, func(el time.Duration) {
		p := e.lastProgress()
		p.Stage, p.Distro = "init", distro
		p.Message = fmt.Sprintf("Aguardando o init do WSL (%s)… %d s", distro, int(el.Seconds()))
		e.Progress(p)
	})
	lifeLog(fmt.Sprintf("init do WSL (%s): terminou em %d s (código %d, erro %q, tempo esgotado %v, fechado pelo usuário %v)",
		distro, int(time.Since(start).Seconds()), out.ExitCode, out.Err, out.TimedOut, out.ClosedByUser))
	return out
}

// hubInitTerm: o initTerm de verdade (terminal pela bridge, wsl.exe de verdade).
type hubInitTerm struct {
	e    *hubRestoreEnv
	skip <-chan struct{}
}

func (t *hubInitTerm) Open(ctx context.Context, distro string) (int, error) {
	return t.e.Spawn(ctx, paneSpec{Kind: "wsl", ShellID: "wsl.default", Distro: distro}, "")
}

func (t *hubInitTerm) Send(pane int, data string) error {
	if t.e.h.bridge == nil {
		return errBridgeDown
	}
	return t.e.h.bridge.write(map[string]any{"op": "send", "pane_id": pane, "data": data})
}

func (t *hubInitTerm) Alive(pane int) bool { return settings.liveHas([]int{pane}) }

func (t *hubInitTerm) Kill(pane int) {
	if t.e.h.bridge != nil {
		_ = t.e.h.bridge.write(map[string]any{"op": "kill", "pane_id": pane})
	}
}

func (t *hubInitTerm) Run(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	return execRunner(ctx, timeout, name, args...)
}

func (t *hubInitTerm) Now() time.Time        { return time.Now() }
func (t *hubInitTerm) Sleep(d time.Duration) { time.Sleep(d) }
func (t *hubInitTerm) Skip() <-chan struct{} { return t.skip }
