package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPonteRegisterNamesAreUnique(t *testing.T) {
	h := newPonteHub()
	a := h.register("", "windows-repo", "windows", `C:\repo`, 1)
	b := h.register("", "windows-repo", "windows", `C:\repo`, 2)
	if a.Name != "windows-repo" || b.Name != "windows-repo 2" {
		t.Fatalf("nomes %q %q", a.Name, b.Name)
	}
	// re-registro com o mesmo id mantém o nome
	if again := h.register(a.ID, "windows-repo", "windows", `C:\repo`, 1); again.ID != a.ID || again.Name != "windows-repo" {
		t.Fatalf("re-registro: %+v", again)
	}
	if c := h.register("", "  um nome  com espaço ", "WSL", "/home", 3); c.Name != "um nome com espaço" || c.Side != "wsl" {
		t.Fatalf("limpeza: %+v", c)
	}
}

func TestPonteSendResolvesSideNameAndAmbiguity(t *testing.T) {
	h := newPonteHub()
	win := h.register("", "windows-beth", "windows", `C:\beth`, 1)
	wsl := h.register("", "wsl-api", "wsl", "/home/api", 2)

	m, err := h.send(win.ID, "wsl", "oi do windows")
	if err != nil || m.To != "wsl-api" || m.From != "windows-beth" || m.FromSide != "windows" {
		t.Fatalf("lado: %+v %v", m, err)
	}
	if _, err := h.send(wsl.ID, "@windows-beth", "oi"); err != nil {
		t.Fatalf("nome com @: %v", err)
	}
	if _, err := h.send(wsl.ID, "beth", "oi"); err != nil {
		t.Fatalf("parte do nome: %v", err)
	}
	// nunca para si mesmo
	if _, err := h.send(win.ID, "windows", "eco"); err == nil {
		t.Fatal("mandou para si mesmo")
	}
	h.register("", "wsl-web", "wsl", "/home/web", 3)
	if _, err := h.send(win.ID, "wsl", "?"); err == nil || !strings.Contains(err.Error(), "mais de um") {
		t.Fatalf("ambíguo: %v", err)
	}
	if _, err := h.send(win.ID, "wsl-web", "exato"); err != nil {
		t.Fatalf("exato ganha do lado: %v", err)
	}
	if _, err := h.send("nao-existe", "wsl", "x"); err != errPonteUnknown {
		t.Fatalf("remetente desconhecido: %v", err)
	}
	if _, err := h.send(win.ID, "wsl-api", strings.Repeat("x", ponteMaxText+1)); err == nil {
		t.Fatal("texto grande demais passou")
	}
}

func TestPonteWaitDeliversAndTimesOut(t *testing.T) {
	h := newPonteHub()
	a := h.register("", "a", "windows", "", 1)
	b := h.register("", "b", "wsl", "", 2)
	got := make(chan []ponteMsg, 1)
	go func() {
		m, _ := h.wait(context.Background(), b.ID, 2*time.Second)
		got <- m
	}()
	time.Sleep(50 * time.Millisecond)
	if _, err := h.send(a.ID, "b", "acorda"); err != nil {
		t.Fatal(err)
	}
	select {
	case m := <-got:
		if len(m) != 1 || m[0].Text != "acorda" {
			t.Fatalf("recebido %+v", m)
		}
	case <-time.After(time.Second):
		t.Fatal("wait não acordou com a mensagem")
	}
	m, err := h.wait(context.Background(), b.ID, 30*time.Millisecond)
	if err != nil || len(m) != 0 {
		t.Fatalf("timeout: %+v %v", m, err)
	}
	if _, err := h.wait(context.Background(), "x", time.Millisecond); err != errPonteUnknown {
		t.Fatalf("desconhecido: %v", err)
	}
}

func TestPontePrunesSilentAgents(t *testing.T) {
	h := newPonteHub()
	now := time.Unix(1_800_000_000, 0)
	h.now = func() time.Time { return now }
	h.register("", "velho", "wsl", "", 1)
	now = now.Add(ponteStale + time.Second)
	if l := h.list(); len(l) != 0 {
		t.Fatalf("agente sem sinal continuou: %+v", l)
	}
}

func TestPonteDetectSideAndName(t *testing.T) {
	t.Setenv("WSL_DISTRO_NAME", "")
	if s := ponteDetectSide("", `\\wsl.localhost\Debian\home\u\repo`); s != "wsl" {
		t.Fatalf("UNC: %s", s)
	}
	if s := ponteDetectSide("", `\\wsl$\Debian\x`); s != "wsl" {
		t.Fatalf("wsl$: %s", s)
	}
	if s := ponteDetectSide("", `C:\repo`); s != "windows" {
		t.Fatalf("windows: %s", s)
	}
	if s := ponteDetectSide("wsl", `C:\repo`); s != "wsl" {
		t.Fatalf("flag: %s", s)
	}
	if n := ponteDefaultName("wsl", `\\wsl.localhost\Debian\home\u\Meu-Repo`); n != "wsl-meu-repo" {
		t.Fatalf("nome: %s", n)
	}
	if n := ponteDefaultName("windows", `C:\`); n != "windows" {
		t.Fatalf("raiz: %s", n)
	}
}

func TestPonteCommandsForBothSides(t *testing.T) {
	win, wsl, _, _ := ponteCommands(`C:\Users\Public\BethStudio\bethstudio-tool.exe`)
	if win != `claude mcp add --scope user beth-ponte -- "C:\Users\Public\BethStudio\bethstudio-tool.exe" ponte-mcp` {
		t.Fatalf("windows: %s", win)
	}
	if wsl != `claude mcp add --scope user beth-ponte -e WSLENV=CLAUDE_CODE_SESSION_ID -- '/mnt/c/Users/Public/BethStudio/bethstudio-tool.exe' ponte-mcp --lado wsl` {
		t.Fatalf("wsl: %s", wsl)
	}
}

// Dois servidores MCP (como o Claude do Windows e o do WSL) falando por um
// Studio de verdade (rotas /api/ponte/*), só que em memória.
// Checagem de saúde (`claude mcp get`): abre, inicializa e fecha em menos de
// um segundo. Não pode virar agente fantasma na lista.
func TestPonteHealthCheckDoesNotJoin(t *testing.T) {
	startPonteStudio(t)
	old := ponteRegisterDelay
	ponteRegisterDelay = 400 * time.Millisecond
	t.Cleanup(func() { ponteRegisterDelay = old })

	hc := startMCP(t, "--nome", "checagem", "--sessao", "hc-1")
	hc.init(t)
	hc.in.Close() // a checagem termina
	time.Sleep(700 * time.Millisecond)
	if l := ponte.list(); len(l) != 0 {
		t.Fatalf("checagem rápida entrou na ponte: %+v", l)
	}

	// sessão de verdade: entra depois do atraso
	real := startMCP(t, "--nome", "sessao", "--sessao", "real-1")
	real.init(t)
	deadline := time.Now().Add(3 * time.Second)
	for len(ponte.list()) < 1 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if l := ponte.list(); len(l) != 1 || l[0].Name != "sessao" {
		t.Fatalf("sessão não entrou: %+v", l)
	}
}

// startPonteStudio: Studio de verdade (rotas /api/ponte/*) numa porta local,
// com a ponte ligada e o ponte.json numa pasta temporária.
func startPonteStudio(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("BETHSTUDIO_DATA_DIR", dir)
	settings.load(dir)
	if err := settings.setPonte(PonteSettings{Enabled: true}); err != nil {
		t.Fatal(err)
	}
	old := ponte
	ponte = newPonteHub()
	t.Cleanup(func() { ponte = old })
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	srv := &http.Server{Handler: newServer("tok", port, "", newHub(false))}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	ponteSetAddr(dir, "http://127.0.0.1:"+itoa(port), "tok")
	t.Cleanup(ponteUnpublish)
	return dir
}

func TestPonteMCPEndToEnd(t *testing.T) {
	oldDelay := ponteRegisterDelay
	ponteRegisterDelay = 0
	t.Cleanup(func() { ponteRegisterDelay = oldDelay })
	dir := t.TempDir()
	t.Setenv("BETHSTUDIO_DATA_DIR", dir)
	settings.load(dir)
	if err := settings.setPonte(PonteSettings{Enabled: true}); err != nil {
		t.Fatal(err)
	}
	old := ponte
	ponte = newPonteHub()
	t.Cleanup(func() { ponte = old })

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	srv := &http.Server{Handler: newServer("tok", port, "", newHub(false))}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	base := "http://127.0.0.1:" + itoa(port)
	ponteSetAddr(dir, base, "tok")
	t.Cleanup(ponteUnpublish)
	if _, err := os.Stat(filepath.Join(dir, ponteFileName)); err != nil {
		t.Fatal("ponte.json não foi gravado com a ponte ligada")
	}

	win := startMCP(t, "--nome", "win-a", "--sessao", "e2e-win")
	wsl := startMCP(t, "--nome", "wsl-b", "--lado", "wsl", "--sessao", "e2e-wsl")
	win.init(t)
	wsl.init(t)

	// espera os dois entrarem na ponte
	deadline := time.Now().Add(3 * time.Second)
	for len(ponte.list()) < 2 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := len(ponte.list()); n != 2 {
		t.Fatalf("agentes na ponte: %d", n)
	}

	r := win.call(t, "ponte_enviar", map[string]any{"para": "wsl", "mensagem": "qual a versão do kernel?"})
	if !strings.Contains(r, "Entregue a wsl-b") {
		t.Fatalf("enviar: %s", r)
	}
	// do lado WSL: o canal empurra e o aguardar devolve
	push := wsl.waitNotification(t)
	if !strings.Contains(push, "qual a versão do kernel?") || !strings.Contains(push, "NÃO é do usuário") {
		t.Fatalf("canal: %s", push)
	}
	got := wsl.call(t, "ponte_aguardar", map[string]any{"segundos": 2})
	if !strings.Contains(got, "de win-a (windows)") || !strings.Contains(got, "qual a versão do kernel?") {
		t.Fatalf("aguardar: %s", got)
	}
	// resposta volta para o Windows
	if r := wsl.call(t, "ponte_enviar", map[string]any{"para": "win-a", "mensagem": "6.6"}); !strings.Contains(r, "Entregue") {
		t.Fatalf("resposta: %s", r)
	}
	if got := win.call(t, "ponte_aguardar", map[string]any{"segundos": 2}); !strings.Contains(got, "6.6") {
		t.Fatalf("windows recebeu: %s", got)
	}
	if got := win.call(t, "ponte_agentes", map[string]any{}); !strings.Contains(got, "wsl-b (wsl)") || !strings.Contains(got, "← você") {
		t.Fatalf("agentes: %s", got)
	}

	// desligar a ponte apaga o ponte.json e recusa os agentes
	settings.setPonte(PonteSettings{Enabled: false})
	ponteSync(false)
	if _, err := os.Stat(filepath.Join(dir, ponteFileName)); err == nil {
		t.Fatal("ponte.json ficou com a ponte desligada")
	}
	if r := win.call(t, "ponte_enviar", map[string]any{"para": "wsl-b", "mensagem": "x"}); !strings.Contains(r, "Não enviei") {
		t.Fatalf("ponte desligada aceitou: %s", r)
	}
}


type mcpProc struct {
	in    io.WriteCloser
	lines chan map[string]any
	notes chan string
	next  int
}

func startMCP(t *testing.T, args ...string) *mcpProc {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	go func() { ponteMCPMain(args, inR, outW); outW.Close() }()
	p := &mcpProc{in: inW, lines: make(chan map[string]any, 32), notes: make(chan string, 32)}
	go func() {
		sc := bufio.NewScanner(outR)
		sc.Buffer(make([]byte, 1<<20), 8<<20)
		for sc.Scan() {
			var m map[string]any
			if json.Unmarshal(sc.Bytes(), &m) != nil {
				continue
			}
			if m["method"] == "notifications/claude/channel" {
				params, _ := m["params"].(map[string]any)
				s, _ := params["content"].(string)
				p.notes <- s
				continue
			}
			p.lines <- m
		}
	}()
	t.Cleanup(func() { inW.Close() })
	return p
}

func (p *mcpProc) send(t *testing.T, v any) {
	b, _ := json.Marshal(v)
	if _, err := p.in.Write(append(b, '\n')); err != nil {
		t.Fatal(err)
	}
}

func (p *mcpProc) recv(t *testing.T) map[string]any {
	select {
	case m := <-p.lines:
		return m
	case <-time.After(5 * time.Second):
		t.Fatal("sem resposta do servidor MCP")
	}
	return nil
}

func (p *mcpProc) init(t *testing.T) {
	p.next++
	p.send(t, map[string]any{"jsonrpc": "2.0", "id": p.next, "method": "initialize", "params": map[string]any{"protocolVersion": "2025-06-18"}})
	r := p.recv(t)
	res, _ := r["result"].(map[string]any)
	caps, _ := res["capabilities"].(map[string]any)
	exp, _ := caps["experimental"].(map[string]any)
	if _, ok := exp["claude/channel"]; !ok || res["protocolVersion"] != "2025-06-18" {
		t.Fatalf("initialize: %+v", r)
	}
	p.send(t, map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"})
	p.next++
	p.send(t, map[string]any{"jsonrpc": "2.0", "id": p.next, "method": "tools/list"})
	tl := p.recv(t)
	tools, _ := tl["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 3 {
		t.Fatalf("tools/list: %+v", tl)
	}
}

func (p *mcpProc) call(t *testing.T, name string, args map[string]any) string {
	p.next++
	p.send(t, map[string]any{"jsonrpc": "2.0", "id": p.next, "method": "tools/call", "params": map[string]any{"name": name, "arguments": args}})
	r := p.recv(t)
	res, _ := r["result"].(map[string]any)
	content, _ := res["content"].([]any)
	if len(content) == 0 {
		t.Fatalf("%s: %+v", name, r)
	}
	s, _ := content[0].(map[string]any)["text"].(string)
	return s
}

func (p *mcpProc) waitNotification(t *testing.T) string {
	select {
	case s := <-p.notes:
		return s
	case <-time.After(5 * time.Second):
		t.Fatal("o canal não empurrou a mensagem")
	}
	return ""
}
