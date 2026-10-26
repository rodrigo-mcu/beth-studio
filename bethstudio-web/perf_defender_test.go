package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type perfFake struct {
	av       []string
	supp     bool
	code     int
	err      error
	script   string
	elevated int
	opened   int
}

func newPerfFake(t *testing.T) (*perfFake, string, string) {
	t.Helper()
	f := &perfFake{av: []string{"Windows Defender"}, supp: true}
	exeDir := t.TempDir()
	data := t.TempDir()
	pa, pe, pd, pf, po := perfAntivirus, perfElevate, perfExecutable, perfDataDir, perfOpenSecurity
	perfAntivirus = func() ([]string, bool) { return f.av, f.supp }
	perfElevate = func(_ context.Context, script string) (int, error) {
		f.elevated++
		f.script = script
		return f.code, f.err
	}
	perfExecutable = func() (string, error) { return filepath.Join(exeDir, "bethstudio-web.exe"), nil }
	perfDataDir = func() string { return data }
	perfOpenSecurity = func() error { f.opened++; return nil }
	t.Cleanup(func() { perfAntivirus, perfElevate, perfExecutable, perfDataDir, perfOpenSecurity = pa, pe, pd, pf, po })
	return f, exeDir, data
}

func perfCall(s *server, method, path, remoteKey, body string) (int, map[string]any) {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	w := httptest.NewRecorder()
	s.servePerfDefender(w, r, remoteKey)
	var m map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &m)
	return w.Code, m
}

func TestDefenderScriptQuotesAndVerifies(t *testing.T) {
	s := defenderScript([]string{`C:\Users\O'Brien\Beth Studio`, `D:\dados`}, false)
	for _, want := range []string{
		`@('C:\Users\O''Brien\Beth Studio','D:\dados')`,
		"Add-MpPreference -ExclusionPath $p",
		"if (-not $has) { exit 4 }",
		"catch { exit 3 }",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("script sem %q:\n%s", want, s)
		}
	}
	r := defenderScript([]string{`C:\x`}, true)
	if !strings.Contains(r, "Remove-MpPreference -ExclusionPath $p") || !strings.Contains(r, "if ($has) { exit 4 }") || strings.Contains(r, "Add-MpPreference") {
		t.Errorf("script de remoção errado:\n%s", r)
	}
}

func TestDefenderPathsOnlyExistingAndDedup(t *testing.T) {
	_, exeDir, data := newPerfFake(t)
	got := defenderPaths()
	if len(got) != 2 || got[0].Path != filepath.Clean(exeDir) || got[1].Path != filepath.Clean(data) {
		t.Fatalf("caminhos: %+v", got)
	}
	// pasta de dados igual à do programa: uma só entrada
	perfDataDir = func() string { return exeDir }
	if got := defenderPaths(); len(got) != 1 {
		t.Fatalf("duplicada: %+v", got)
	}
	// pasta que não existe não entra
	perfDataDir = func() string { return filepath.Join(os.TempDir(), "nao-existe-bethstudio-xyz") }
	if got := defenderPaths(); len(got) != 1 {
		t.Fatalf("inexistente entrou: %+v", got)
	}
}

func TestDefenderStatus(t *testing.T) {
	f, _, _ := newPerfFake(t)
	s := &server{}
	code, m := perfCall(s, http.MethodGet, "/api/perf/defender", "", "")
	if code != 200 || m["defender"] != true || m["supported"] != true {
		t.Fatalf("status: %d %v", code, m)
	}
	f.av = []string{"Kaspersky"}
	_, m = perfCall(s, http.MethodGet, "/api/perf/defender", "", "")
	if m["defender"] != false {
		t.Fatalf("Kaspersky não é o Defender: %v", m)
	}
	f.av, f.supp = nil, false
	_, m = perfCall(s, http.MethodGet, "/api/perf/defender", "", "")
	if m["supported"] != false || m["antivirus"] == nil {
		t.Fatalf("sem suporte: %v", m)
	}
}

func TestDefenderApplyRequiresConfirmAndPC(t *testing.T) {
	f, _, _ := newPerfFake(t)
	s := &server{}
	if code, _ := perfCall(s, http.MethodPost, "/api/perf/defender/apply", "", `{}`); code != http.StatusBadRequest || f.elevated != 0 {
		t.Fatalf("sem confirm: code=%d elevou=%d", code, f.elevated)
	}
	if code, _ := perfCall(s, http.MethodPost, "/api/perf/defender/apply", "", `{"confirm":false}`); code != http.StatusBadRequest || f.elevated != 0 {
		t.Fatalf("confirm=false: code=%d", code)
	}
	if code, _ := perfCall(s, http.MethodGet, "/api/perf/defender/apply", "", ""); code != http.StatusMethodNotAllowed {
		t.Fatalf("GET aplicou: %d", code)
	}
	// Studio remoto: nunca
	if code, _ := perfCall(s, http.MethodPost, "/api/perf/defender/apply", "chave", `{"confirm":true}`); code != http.StatusForbidden || f.elevated != 0 {
		t.Fatalf("remoto: code=%d elevou=%d", code, f.elevated)
	}
	if code, _ := perfCall(s, http.MethodGet, "/api/perf/defender", "chave", ""); code != http.StatusForbidden {
		t.Fatalf("status remoto: %d", code)
	}
	// somente leitura
	ro := &server{hub: &hub{readOnly: true}}
	if code, _ := perfCall(ro, http.MethodPost, "/api/perf/defender/apply", "", `{"confirm":true}`); code != http.StatusForbidden || f.elevated != 0 {
		t.Fatalf("somente leitura: code=%d", code)
	}
	if !remoteBlocked("/api/perf/defender/apply", http.MethodPost) || !remoteBlocked("/api/perf/defender", http.MethodGet) {
		t.Fatal("/api/perf/ deveria ficar só no PC")
	}
}

func TestDefenderApplyOutcomes(t *testing.T) {
	f, exeDir, data := newPerfFake(t)
	s := &server{}
	cases := []struct {
		code   int
		status int
		part   string
	}{
		{defenderOK, 200, "foram adicionadas"},
		{defenderCancelled, http.StatusConflict, "recusou"},
		{defenderNotKept, http.StatusConflict, "não ficou valendo"},
		{defenderFailed, http.StatusInternalServerError, "Segurança do Windows"},
	}
	for _, c := range cases {
		f.code = c.code
		code, m := perfCall(s, http.MethodPost, "/api/perf/defender/apply", "", `{"confirm":true}`)
		text, _ := m["message"].(string)
		if text == "" {
			text, _ = m["error"].(string)
		}
		if code != c.status || !strings.Contains(text, c.part) {
			t.Errorf("code %d => %d %q (queria %d ...%q...)", c.code, code, text, c.status, c.part)
		}
	}
	// o script elevado recebeu exatamente as duas pastas
	for _, p := range []string{exeDir, data} {
		if !strings.Contains(f.script, psQuote(filepath.Clean(p))) {
			t.Errorf("script não tem %s:\n%s", p, f.script)
		}
	}
	// remover usa o script de remoção e mensagem própria
	f.code = defenderOK
	_, m := perfCall(s, http.MethodPost, "/api/perf/defender/remove", "", `{"confirm":true}`)
	if !strings.Contains(f.script, "Remove-MpPreference") || !strings.Contains(m["message"].(string), "removidas") {
		t.Errorf("remoção: %v\n%s", m, f.script)
	}
}

func TestDefenderApplyRefusesOtherAntivirusAndNoPaths(t *testing.T) {
	f, _, _ := newPerfFake(t)
	s := &server{}
	f.av = []string{"Kaspersky"}
	if code, _ := perfCall(s, http.MethodPost, "/api/perf/defender/apply", "", `{"confirm":true}`); code != http.StatusBadRequest || f.elevated != 0 {
		t.Fatalf("outro antivírus: code=%d elevou=%d", code, f.elevated)
	}
	f.av = []string{"Windows Defender"}
	perfExecutable = func() (string, error) { return "", os.ErrNotExist }
	perfDataDir = func() string { return "" }
	if code, _ := perfCall(s, http.MethodPost, "/api/perf/defender/apply", "", `{"confirm":true}`); code != http.StatusBadRequest || f.elevated != 0 {
		t.Fatalf("sem pastas: code=%d", code)
	}
}

func TestDefenderOpenSecurity(t *testing.T) {
	f, _, _ := newPerfFake(t)
	s := &server{}
	if code, _ := perfCall(s, http.MethodPost, "/api/perf/defender/open-security", "", ""); code != 200 || f.opened != 1 {
		t.Fatalf("abrir: code=%d opened=%d", code, f.opened)
	}
	if code, _ := perfCall(s, http.MethodPost, "/api/perf/defender/open-security", "chave", ""); code != http.StatusForbidden || f.opened != 1 {
		t.Fatalf("remoto abriu: code=%d", code)
	}
}
