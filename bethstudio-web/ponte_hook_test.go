package main

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const userSettings = `{
  "model": "sonnet",
  "permissions": {"allow": ["Bash(ls:*)"]},
  "hooks": {
    "Stop": [
      {"hooks": [{"type": "command", "command": "\"C:/x/swarmterm.exe\" --hook", "timeout": 5}]}
    ],
    "PostToolUse": [
      {"matcher": "Write", "hooks": [{"type": "command", "command": "fmt.sh"}]}
    ]
  }
}`

func hookCmd() string {
	return ponteHookCommand(`C:\Users\Public\BethStudio\bethstudio-tool.exe`, false)
}

func countOurs(t *testing.T, raw []byte, ev string) int {
	t.Helper()
	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil {
		t.Fatalf("json inválido: %v\n%s", err, raw)
	}
	n := 0
	hooks, _ := root["hooks"].(map[string]any)
	groups, _ := hooks[ev].([]any)
	for _, g := range groups {
		inner, _ := g.(map[string]any)["hooks"].([]any)
		for _, h := range inner {
			if ponteHookIsOurs(h) {
				n++
			}
		}
	}
	return n
}

func TestPonteHookCommandFormats(t *testing.T) {
	if c := hookCmd(); c != `"C:/Users/Public/BethStudio/bethstudio-tool.exe" ponte-hook` {
		t.Fatalf("windows: %s", c)
	}
	if c := ponteHookCommand(`C:\Users\Public\BethStudio\bethstudio-tool.exe`, true); c != `'/mnt/c/Users/Public/BethStudio/bethstudio-tool.exe' ponte-hook` {
		t.Fatalf("wsl: %s", c)
	}
}

func TestPonteHookAddKeepsEverythingElse(t *testing.T) {
	out, on, err := ponteHookEdit([]byte(userSettings), "add", hookCmd())
	if err != nil || !on || out == nil {
		t.Fatalf("add: %v %v", on, err)
	}
	for _, ev := range ponteHookEvents {
		if n := countOurs(t, out, ev); n != 1 {
			t.Fatalf("%s: %d hooks nossos", ev, n)
		}
	}
	s := string(out)
	for _, keep := range []string{`"model": "sonnet"`, `Bash(ls:*)`, `swarmterm.exe`, `"matcher": "Write"`, `fmt.sh`, `"asyncRewake": true`} {
		if !strings.Contains(s, keep) {
			t.Fatalf("perdeu %q:\n%s", keep, s)
		}
	}
	// ligar de novo não duplica
	again, _, err := ponteHookEdit(out, "add", hookCmd())
	if err != nil {
		t.Fatal(err)
	}
	if again == nil {
		again = out
	}
	for _, ev := range ponteHookEvents {
		if n := countOurs(t, again, ev); n != 1 {
			t.Fatalf("duplicou em %s: %d", ev, n)
		}
	}
	// o hook dos outros programas continua no Stop, antes do nosso
	if !strings.Contains(string(again), "swarmterm.exe") {
		t.Fatal("hook alheio sumiu")
	}
}

func TestPonteHookRemoveRestoresShape(t *testing.T) {
	added, _, _ := ponteHookEdit([]byte(userSettings), "add", hookCmd())
	removed, on, err := ponteHookEdit(added, "remove", "")
	if err != nil || on || removed == nil {
		t.Fatalf("remove: %v %v", on, err)
	}
	for _, ev := range ponteHookEvents {
		if n := countOurs(t, removed, ev); n != 0 {
			t.Fatalf("%s ainda tem %d", ev, n)
		}
	}
	var a, b map[string]any
	_ = json.Unmarshal([]byte(userSettings), &a)
	_ = json.Unmarshal(removed, &b)
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	if string(ja) != string(jb) {
		t.Fatalf("depois de ligar e desligar, o arquivo mudou:\n%s\n%s", ja, jb)
	}
	// SessionStart só tinha o nosso: a chave some, sem deixar lista vazia
	if strings.Contains(string(removed), `"SessionStart"`) {
		t.Fatal("SessionStart vazio ficou no arquivo")
	}
}

func TestPonteHookEditEdgeCases(t *testing.T) {
	// arquivo vazio/inexistente
	out, on, err := ponteHookEdit(nil, "add", hookCmd())
	if err != nil || !on || countOurs(t, out, "Stop") != 1 {
		t.Fatalf("vazio: %v %v", on, err)
	}
	// JSON inválido: não mexe
	if _, _, err := ponteHookEdit([]byte(`{"hooks": [`), "add", hookCmd()); err == nil {
		t.Fatal("aceitou JSON inválido")
	}
	// check
	if _, on, _ := ponteHookEdit(out, "check", ""); !on {
		t.Fatal("check não viu o hook ligado")
	}
	if _, on, _ := ponteHookEdit([]byte(userSettings), "check", ""); on {
		t.Fatal("check viu hook que não existe")
	}
	// remover sem nada: sem mudança
	if o, _, err := ponteHookEdit([]byte(userSettings), "remove", ""); err != nil || o != nil {
		t.Fatalf("remove sem hook mudou algo: %v %v", o != nil, err)
	}
}

func TestPonteHookApplyBacksUpOnce(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(userSettings), 0o600); err != nil {
		t.Fatal(err)
	}
	if on, _, err := ponteHookApply(path, "add", hookCmd()); err != nil || !on {
		t.Fatalf("add: %v %v", on, err)
	}
	bak, err := os.ReadFile(path + ".beth-ponte.bak")
	if err != nil || string(bak) != userSettings {
		t.Fatalf("backup: %v", err)
	}
	if on, _, err := ponteHookApply(path, "remove", ""); err != nil || on {
		t.Fatalf("remove: %v %v", on, err)
	}
	bak2, _ := os.ReadFile(path + ".beth-ponte.bak")
	if string(bak2) != userSettings {
		t.Fatal("o backup original foi sobrescrito")
	}
}

// Fluxo do hook com um Studio de verdade: não acorda sem mensagem, acorda
// (exit 2) quando chega mensagem não lida, e não acorda de novo depois que o
// modelo leu (ack).
func TestPonteHookWakesOnlyOnUnread(t *testing.T) {
	startPonteStudio(t)
	oldPoll, oldRetry, oldReg := ponteHookPoll, ponteHookRetry, ponteHookRegisterWait
	ponteHookPoll, ponteHookRetry, ponteHookRegisterWait = 300, 50*time.Millisecond, 2*time.Second
	t.Cleanup(func() { ponteHookPoll, ponteHookRetry, ponteHookRegisterWait = oldPoll, oldRetry, oldReg })
	oldDelay := ponteRegisterDelay
	ponteRegisterDelay = 0
	t.Cleanup(func() { ponteRegisterDelay = oldDelay })

	// o servidor MCP da sessão (id = cc-sessao-teste-1) e um remetente
	me := startMCP(t, "--nome", "alvo", "--lado", "wsl", "--sessao", "sessao-teste-1")
	me.init(t)
	other := ponte.register("", "remetente", "windows", "", 9)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if reg, _ := ponte.unread("cc-sessao-teste-1"); reg {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if reg, _ := ponte.unread("cc-sessao-teste-1"); !reg {
		t.Fatal("o agente da sessão não entrou na ponte com o id da sessão")
	}

	run := func() (int, string) {
		var stderr bytes.Buffer
		code := ponteHookMain(nil, strings.NewReader(`{"session_id":"sessao-teste-1","hook_event_name":"Stop"}`), &stderr)
		return code, stderr.String()
	}

	// sem mensagem: o hook é substituído por um novo e sai sem acordar
	done := make(chan int, 1)
	go func() { c, _ := run(); done <- c }()
	time.Sleep(150 * time.Millisecond)
	codeCh := make(chan int, 1)
	var stderr2 bytes.Buffer
	go func() {
		codeCh <- ponteHookMain(nil, strings.NewReader(`{"session_id":"sessao-teste-1"}`), &stderr2)
	}()
	select {
	case c := <-done:
		if c != 0 {
			t.Fatalf("o hook antigo devia sair em silêncio (0), saiu %d", c)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("o hook antigo não saiu quando outro assumiu a vez")
	}

	// chega mensagem: o hook atual acorda a sessão
	if _, err := ponte.send(other.ID, "alvo", "olá"); err != nil {
		t.Fatal(err)
	}
	select {
	case c := <-codeCh:
		if c != 2 || !strings.Contains(stderr2.String(), "ponte_aguardar") || strings.Contains(stderr2.String(), "olá") {
			t.Fatalf("acordar: código %d, texto %q (não pode levar o conteúdo da mensagem)", c, stderr2.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("o hook não acordou com mensagem não lida")
	}

	// o modelo lê pela ferramenta; a partir daí não há o que acordar
	got := me.call(t, "ponte_aguardar", map[string]any{"segundos": 2})
	if !strings.Contains(got, "olá") {
		t.Fatalf("ponte_aguardar: %s", got)
	}
	if _, n := ponte.unread("cc-sessao-teste-1"); n != 0 {
		t.Fatal("mensagem lida continuou como não lida")
	}
	// Stop com mensagem não lida acorda na hora, sem esperar
	if _, err := ponte.send(other.ID, "alvo", "de novo"); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	if c, _ := run(); c != 2 || time.Since(start) > 2*time.Second {
		t.Fatalf("com não lida deveria acordar na hora: código %d em %s", c, time.Since(start))
	}
}

func TestPonteHookWithoutStudioDoesNothing(t *testing.T) {
	t.Setenv("BETHSTUDIO_PONTE_FILE", filepath.Join(t.TempDir(), "nao-existe.json"))
	var stderr bytes.Buffer
	if c := ponteHookMain(nil, strings.NewReader(`{"session_id":"x"}`), &stderr); c != 0 || stderr.Len() != 0 {
		t.Fatalf("sem Studio: %d %q", c, stderr.String())
	}
	if c := ponteHookMain(nil, strings.NewReader(`lixo`), &stderr); c != 0 {
		t.Fatalf("entrada inválida: %d", c)
	}
}

func TestPonteAgentIDFromSession(t *testing.T) {
	t.Setenv("CLAUDE_CODE_SESSION_ID", "")
	if id := ponteSessionAgentID(); id != "" {
		t.Fatalf("sem sessão: %q", id)
	}
	t.Setenv("CLAUDE_CODE_SESSION_ID", "abc-123")
	if id := ponteSessionAgentID(); id != "cc-abc-123" {
		t.Fatalf("com sessão: %q", id)
	}
	t.Setenv("CLAUDE_CODE_SESSION_ID", "../x")
	if id := ponteSessionAgentID(); id != "" {
		t.Fatalf("id suspeito aceito: %q", id)
	}
}

// Sessão retomada/reconectada (mesmo id) reaproveita nome e fila.
func TestPonteSameSessionKeepsNameAndQueue(t *testing.T) {
	h := newPonteHub()
	a := h.register("cc-s1", "wsl-mobi-server", "wsl", "/x", 1)
	other := h.register("", "windows-mobi", "windows", "", 2)
	if _, err := h.send(other.ID, "wsl-mobi-server", "fila"); err != nil {
		t.Fatal(err)
	}
	b := h.register("cc-s1", "wsl-mobi-server", "wsl", "/x", 99) // reconectou
	if b.ID != a.ID || b.Name != "wsl-mobi-server" {
		t.Fatalf("perdeu a identidade: %+v", b)
	}
	m, _ := h.wait(t.Context(), "cc-s1", 100*time.Millisecond)
	if len(m) != 1 || m[0].Text != "fila" {
		t.Fatalf("perdeu a fila: %+v", m)
	}
	// outra sessão na mesma pasta ganha sufixo
	c := h.register("cc-s2", "wsl-mobi-server", "wsl", "/x", 3)
	if c.Name != "wsl-mobi-server 2" {
		t.Fatalf("segunda sessão: %q", c.Name)
	}
}

func TestPonteNotifyEndpoint(t *testing.T) {
	startPonteStudio(t)
	a := ponte.register("cc-n1", "a", "windows", "", 1)
	b := ponte.register("", "b", "wsl", "", 2)
	post := func(path string, body map[string]any) map[string]any {
		bs, _ := json.Marshal(body)
		d := ponteAddr.url
		req, _ := http.NewRequest("POST", d+"/api/ponte"+path, bytes.NewReader(bs))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(tokenHeader, ponteAddr.tok)
		resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return out
	}
	if r := post("/notify", map[string]any{"id": "naoexiste", "timeout_ms": 0}); r["registered"] != false {
		t.Fatalf("desconhecido: %+v", r)
	}
	if r := post("/notify", map[string]any{"id": a.ID, "timeout_ms": 0}); r["registered"] != true || r["unread"].(float64) != 0 {
		t.Fatalf("sem mensagem: %+v", r)
	}
	m, _ := ponte.send(b.ID, "a", "x")
	if r := post("/notify", map[string]any{"id": a.ID, "timeout_ms": 0}); r["unread"].(float64) != 1 {
		t.Fatalf("com mensagem: %+v", r)
	}
	post("/ack", map[string]any{"id": a.ID, "upto": m.ID})
	if r := post("/notify", map[string]any{"id": a.ID, "timeout_ms": 0}); r["unread"].(float64) != 0 {
		t.Fatalf("depois do ack: %+v", r)
	}
	_ = net.IPv4len
}
