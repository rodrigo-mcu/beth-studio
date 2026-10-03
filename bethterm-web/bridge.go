package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// bridge owns the single `bethterm.exe cli bridge` child process. It restarts
// it with backoff when it exits and tells the hub about every state change.
//
// The bridge is a plain mux client (like `cli list`): it never starts, stops
// or signals the host. Closing its stdin ends it.
type bridge struct {
	exe string
	hub *hub

	mu    sync.Mutex
	stdin io.WriteCloser // nil while the bridge is down
	cmd   *exec.Cmd
}

func newBridge(exe string, h *hub) *bridge {
	return &bridge{exe: exe, hub: h}
}

// run keeps the bridge alive until ctx is cancelled.
func (b *bridge) run(ctx context.Context) {
	backoff := 500 * time.Millisecond
	const maxBackoff = 15 * time.Second
	for {
		if ctx.Err() != nil {
			return
		}
		b.hub.setStatus("starting", "iniciando a ponte com o BethTerm")
		started := time.Now()
		err := b.runOnce(ctx)
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) > 20*time.Second {
			backoff = 500 * time.Millisecond
		}
		msg := "a ponte com o BethTerm terminou"
		if err != nil {
			msg = fmt.Sprintf("a ponte com o BethTerm terminou: %v", err)
		}
		log.Printf("bridge: %s; nova tentativa em %s", msg, backoff)
		b.hub.setStatus("down", fmt.Sprintf("%s — nova tentativa em %.0fs", msg, backoff.Seconds()+0.49))
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

func (b *bridge) runOnce(ctx context.Context) error {
	if _, err := os.Stat(b.exe); err != nil {
		return fmt.Errorf("bethterm.exe não encontrado em %s", b.exe)
	}
	cmd := exec.Command(b.exe, "cli", "bridge")
	hideChildWindow(&cmd.SysProcAttr)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	log.Printf("bridge: pid %d iniciado (%s cli bridge)", cmd.Process.Pid, b.exe)

	b.mu.Lock()
	b.stdin = stdin
	b.cmd = cmd
	b.mu.Unlock()

	go func() {
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		for sc.Scan() {
			log.Printf("bridge stderr: %s", sc.Text())
		}
	}()

	// If ctx ends, close stdin: that is the documented way to end the bridge.
	stopWatch := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			b.closeStdin()
		case <-stopWatch:
		}
	}()

	gotFirst := false
	var badSince time.Time
	restarting := false
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 256<<10), 64<<20)
	b.resync()
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		if !gotFirst && !bytesHasPrefix(line, `{"ev":"error"`) {
			gotFirst = true
			b.hub.setStatus("up", "conectado ao BethTerm")
		}
		ev := b.hub.fromBridge(line)
		switch {
		case ev.Ev == "list":
			badSince = time.Time{}
		case ev.Ev == "error" && strings.HasPrefix(ev.Message, "list:"):
			// The bridge re-polls the list every 2 s. If its mux connection
			// died (seen 2026-09-25: os error 10054, then ChannelSendError
			// forever) it keeps running but can no longer talk to the host:
			// restart it.
			if badSince.IsZero() {
				badSince = time.Now()
			} else if !restarting && time.Since(badSince) > unhealthyAfter {
				restarting = true
				log.Printf("bridge: sem conexão com o host há %s (%s); reiniciando a ponte", time.Since(badSince).Round(time.Second), ev.Message)
				b.hub.setStatus("down", "a ponte perdeu a conexão com o BethTerm; reiniciando")
				b.closeStdin()
				go b.killIfStuck(cmd, 2*time.Second)
			}
		}
	}
	scanErr := sc.Err()

	close(stopWatch)
	b.closeStdin()
	waitErr := cmd.Wait()
	b.mu.Lock()
	b.cmd = nil
	b.mu.Unlock()
	b.hub.bridgeGone()
	if scanErr != nil {
		return scanErr
	}
	if waitErr != nil {
		return waitErr
	}
	return errors.New("saída normal")
}

const unhealthyAfter = 5 * time.Second

func bytesHasPrefix(b []byte, p string) bool {
	return strings.HasPrefix(string(b[:min(len(b), len(p))]), p)
}

// killIfStuck kills OUR bridge child if it has not exited after its stdin
// was closed. Never used on any other process.
func (b *bridge) killIfStuck(cmd *exec.Cmd, grace time.Duration) {
	time.Sleep(grace)
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.cmd == cmd && cmd.Process != nil {
		log.Printf("bridge: pid %d não saiu após fechar stdin; encerrando o processo filho", cmd.Process.Pid)
		_ = cmd.Process.Kill()
	}
}

func (b *bridge) closeStdin() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.stdin != nil {
		_ = b.stdin.Close()
		b.stdin = nil
	}
}

// write sends one JSON request line. Returns an error while the bridge is down.
func (b *bridge) write(v any) error {
	line, err := json.Marshal(v)
	if err != nil {
		return err
	}
	line = append(line, '\n')
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.stdin == nil {
		return errBridgeDown
	}
	if _, err := b.stdin.Write(line); err != nil {
		_ = b.stdin.Close()
		b.stdin = nil
		return err
	}
	return nil
}

// stop ends the bridge by closing its stdin, then waits a little; only our
// own child is ever killed, and only if it ignores the closed stdin.
func (b *bridge) stop() {
	b.closeStdin()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		b.mu.Lock()
		c := b.cmd
		b.mu.Unlock()
		if c == nil {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	b.mu.Lock()
	if b.cmd != nil && b.cmd.Process != nil {
		log.Printf("bridge: pid %d não saiu após fechar stdin; encerrando o processo filho", b.cmd.Process.Pid)
		_ = b.cmd.Process.Kill()
	}
	b.mu.Unlock()
}

// errBridgeDown: a ponte ainda nao subiu (ou caiu e esta' reiniciando).
var errBridgeDown = errors.New("ponte com o BethTerm indisponível")

// msgConnecting: o que o usuario ve se uma ACAO dele chega antes da ponte.
const msgConnecting = "O BethTerm ainda está conectando — tente de novo em instantes"

// resync: ao subir (ou reiniciar), a ponte recebe a lista, o conjunto
// observado e as rolagens pedidas enquanto ela nao estava pronta.
func (b *bridge) resync() {
	_ = b.write(map[string]any{"op": "list"})
	if ids := b.hub.watchUnion(); len(ids) > 0 {
		_ = b.write(map[string]any{"op": "watch", "pane_ids": ids})
	}
	for pane, off := range b.hub.scrollOffsets() {
		_ = b.write(map[string]any{"op": "scroll", "pane_id": pane, "offset": off})
	}
}
