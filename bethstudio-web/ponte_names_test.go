package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCleanAgentName(t *testing.T) {
	cases := map[string]string{
		"MOBI VMS":                 "MOBI VMS",
		"  MOBI \t VMS \n":         "MOBI VMS",
		"a\x00b\x07c":              "abc",
		"":                         "",
		strings.Repeat("x", 80):    strings.Repeat("x", 60),
		"CVIDEO LPR - LPR - 3728":  "CVIDEO LPR - LPR - 3728",
		"Sessão do Mário":          "Sessão do Mário",
	}
	for in, want := range cases {
		if got := cleanAgentName(in); got != want {
			t.Errorf("%q -> %q, quer %q", in, got, want)
		}
	}
}

func TestNormKey(t *testing.T) {
	for _, s := range []string{"MOBI VMS", "mobi-vms", "Mobi_Vms", " mobi.vms "} {
		if k := normKey(s); k != "mobivms" {
			t.Errorf("%q -> %q", s, k)
		}
	}
	if normKey("Sessão Ç") != "sessaoc" {
		t.Errorf("acentos: %q", normKey("Sessão Ç"))
	}
}

// O caso real: o nome que a pessoa conhece é "MOBI VMS"; os outros agentes
// da mesma pasta não podem atrapalhar.
func TestPonteResolveByHumanName(t *testing.T) {
	h := newPonteHub()
	me := h.register("", "beth-studio-2f", "windows", `C:\mcu\repo\mobi-lab\beth-studio`, 1)
	vms := h.register("", "MOBI VMS", "windows", `C:\mcu\repo\mobi`, 2)
	ab := h.register("", "mobi-ab", "windows", `C:\mcu\repo\mobi`, 3)
	srv := h.register("", "SERVIDOR GO", "wsl", `\\wsl.localhost\Debian\mnt\kingston\mcu\repo\mobi-server`, 4)

	ok := map[string]string{
		"MOBI VMS":                  vms.ID,
		"mobi vms":                  vms.ID,
		"mobi-vms":                  vms.ID,
		"@MOBI VMS":                 vms.ID,
		"o agente MOBI VMS":         vms.ID, // o nome está dentro do que foi dito
		"mobi-ab":                   ab.ID,
		"servidor go":               srv.ID,
		"wsl":                       srv.ID, // só um no WSL
		"mobi-server":               srv.ID, // pela pasta
		"agente da pasta mobi-server": srv.ID,
	}
	for target, want := range ok {
		h.mu.Lock()
		got := h.resolveLocked(target, me.ID)
		h.mu.Unlock()
		if len(got) != 1 || got[0].ID != want {
			var names []string
			for _, a := range got {
				names = append(names, a.Name)
			}
			t.Errorf("%q -> %v", target, names)
		}
	}
	// ambíguo: "windows" tem dois (fora o remetente) e a mensagem lista nome + pasta
	if _, err := h.send(me.ID, "windows", "?"); err == nil || !strings.Contains(err.Error(), "MOBI VMS (windows) — mobi") || !strings.Contains(err.Error(), "mobi-ab (windows) — mobi") {
		t.Fatalf("ambiguidade: %v", err)
	}
	// ninguém: lista quem está na ponte
	if _, err := h.send(me.ID, "financeiro", "?"); err == nil || !strings.Contains(err.Error(), "MOBI VMS (windows) — mobi") || !strings.Contains(err.Error(), "SERVIDOR GO (wsl) — mobi-server") {
		t.Fatalf("sem destino: %v", err)
	}
}

func writeSession(t *testing.T, dir string, pid int, sid, name, cwd string) {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"pid": pid, "sessionId": sid, "name": name, "cwd": cwd, "kind": "interactive"})
	if err := os.WriteFile(filepath.Join(dir, itoa(pid)+".json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestClaudeSessionNameFromRegistry(t *testing.T) {
	dir := t.TempDir()
	writeSession(t, dir, 326860, "b80dea7c-aaaa", "MOBI VMS", `C:\mcu\repo\mobi`)
	writeSession(t, dir, 79224, "5fad17ed-bbbb", "mobi-ab", `C:\mcu\repo\mobi`)
	writeSession(t, dir, 111, "sem-nome", "", `C:\x`)
	_ = os.WriteFile(filepath.Join(dir, "lixo.json"), []byte("{não é json"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "326860.abc.key"), []byte("segredo"), 0o600) // outros arquivos são ignorados

	dirs := []string{filepath.Join(dir, "nao-existe"), dir}
	if n := claudeSessionName(dirs, "b80dea7c-aaaa", 0); n != "MOBI VMS" {
		t.Fatalf("pelo id da sessão: %q", n)
	}
	if n := claudeSessionName(dirs, "", 79224); n != "mobi-ab" {
		t.Fatalf("pelo pid: %q", n)
	}
	if n := claudeSessionName(dirs, "sem-nome", 0); n != "" {
		t.Fatalf("sessão sem nome devia dar vazio: %q", n)
	}
	if n := claudeSessionName(dirs, "outra", 0); n != "" {
		t.Fatalf("sessão desconhecida: %q", n)
	}
	// o id da sessão manda: não cai no pid de outra sessão
	if n := claudeSessionName(dirs, "outra", 326860); n != "" {
		t.Fatalf("id desconhecido não pode virar o pid de outra sessão: %q", n)
	}
}

func TestWSLDistroFromPathAndDirs(t *testing.T) {
	for in, want := range map[string]string{
		`\\wsl.localhost\Debian\home\rodrigo`: "Debian",
		`\\wsl$\Ubuntu-22.04\root`:            "Ubuntu-22.04",
		`//wsl.localhost/Debian/mnt/x`:        "Debian",
		`C:\mcu\repo`:                         "",
		``:                                    "",
	} {
		if got := wslDistroFromPath(in); got != want {
			t.Errorf("%q -> %q, quer %q", in, got, want)
		}
	}
	t.Setenv("WSL_DISTRO_NAME", "")
	if d := claudeSessionDirs("wsl", `C:\sem\distro`); d != nil {
		t.Fatalf("sem distro não pode chutar pasta: %v", d)
	}
	d := claudeSessionDirs("wsl", `\\wsl.localhost\Debian\mnt\kingston`)
	if len(d) == 0 || !strings.HasPrefix(d[len(d)-1], `\\wsl.localhost\Debian\root`) {
		t.Fatalf("pastas do WSL: %v", d)
	}
	if d := claudeSessionDirs("wsl", `\\wsl.localhost\De bian;x\a`); d != nil && len(d) > 0 {
		for _, p := range d {
			if strings.Contains(p, ";") {
				t.Fatalf("distro com caracteres estranhos aceita: %v", d)
			}
		}
	}
}

func TestWindowsParentPID(t *testing.T) {
	if got, want := windowsParentPID(os.Getpid()), os.Getppid(); got == 0 || got != want {
		t.Fatalf("pai do processo: %d, esperado %d", got, want)
	}
	if windowsParentPID(1<<30) != 0 {
		t.Fatal("pid inexistente devia dar 0")
	}
}

// Servidor antigo (não manda auto_name nem o id da sessão): o Studio descobre
// o claude.exe que o abriu e usa o nome da sessão.
func TestPonteStudioEnrichesOldWindowsAgentNames(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("USERPROFILE", dir)
	t.Setenv("HOME", dir)
	sess := filepath.Join(dir, ".claude", "sessions")
	if err := os.MkdirAll(sess, 0o755); err != nil {
		t.Fatal(err)
	}
	// o "claude.exe" que abriu o servidor é este processo de teste
	writeSession(t, sess, os.Getppid(), "s-pai", "MOBI VMS", `C:\mcu\repo\mobi`)
	startPonteStudio(t)

	// o nome vem da pasta ("windows-mobi"): é trocado
	a := postPonte(t, "/register", map[string]any{"name": "windows-mobi", "side": "windows", "cwd": `C:\mcu\repo\mobi`, "pid": os.Getpid()})
	if a["name"] != "MOBI VMS" {
		t.Fatalf("nome não foi enriquecido: %v", a["name"])
	}
	// nome escolhido de propósito não é trocado
	b := postPonte(t, "/register", map[string]any{"name": "meu-agente", "side": "windows", "cwd": `C:\x`, "pid": os.Getpid()})
	if b["name"] != "meu-agente" {
		t.Fatalf("nome explícito foi trocado: %v", b["name"])
	}
	// lado WSL nunca é enriquecido pelo Studio (o registro dele é de outro sistema)
	c := postPonte(t, "/register", map[string]any{"name": "wsl-mobi-server", "side": "wsl", "cwd": "/x", "pid": os.Getpid()})
	if c["name"] != "wsl-mobi-server" {
		t.Fatalf("lado wsl foi trocado: %v", c["name"])
	}
}

// postPonte: POST em /api/ponte<path> no Studio de teste (startPonteStudio).
func postPonte(t *testing.T, path string, body map[string]any) map[string]any {
	t.Helper()
	bs, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", ponteAddr.url+"/api/ponte"+path, bytes.NewReader(bs))
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
