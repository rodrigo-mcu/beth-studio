package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateWSLInit(t *testing.T) {
	long := strings.Repeat("x", 1025)
	cases := []struct {
		name    string
		distro  string
		cfg     WSLInitCfg
		wantErr bool
		wantSec int
	}{
		{"comando simples, tempo padrão", "Ubuntu", WSLInitCfg{Enabled: true, Command: "init-wsl2"}, false, 300},
		{"espaços nas pontas são aparados", "Ubuntu", WSLInitCfg{Enabled: true, Command: "  init-wsl2  ", TimeoutSec: 60}, false, 60},
		{"quebra de linha vira texto digitado: recusa", "Ubuntu", WSLInitCfg{Enabled: true, Command: "a\nb"}, true, 0},
		{"retorno de carro: recusa", "Ubuntu", WSLInitCfg{Enabled: true, Command: "a\rb"}, true, 0},
		{"comando longo demais", "Ubuntu", WSLInitCfg{Enabled: true, Command: long}, true, 0},
		{"ligado sem comando", "Ubuntu", WSLInitCfg{Enabled: true}, true, 0},
		{"desligado sem comando é ok", "Ubuntu", WSLInitCfg{}, false, 300},
		{"nome de distro inválido", "a b", WSLInitCfg{Enabled: true, Command: "x"}, true, 0},
		{"pasta padrão relativa", "Ubuntu", WSLInitCfg{Command: "x", DefaultDir: "relativa"}, true, 0},
		{"pasta padrão absoluta", "Ubuntu", WSLInitCfg{Command: "x", DefaultDir: "/mnt/kingston/mcu"}, false, 300},
		{"tempo acima do teto vira 1800", "Ubuntu", WSLInitCfg{Command: "x", TimeoutSec: 5000}, false, 1800},
		{"tempo negativo volta ao padrão", "Ubuntu", WSLInitCfg{Command: "x", TimeoutSec: -4}, false, 300},
	}
	for _, c := range cases {
		got, err := validateWSLInit(c.distro, c.cfg)
		if (err != nil) != c.wantErr {
			t.Errorf("%s: err = %v, quero erro=%v", c.name, err, c.wantErr)
			continue
		}
		if err == nil && got.TimeoutSec != c.wantSec {
			t.Errorf("%s: TimeoutSec = %d, quero %d", c.name, got.TimeoutSec, c.wantSec)
		}
		if err == nil && got.Command != strings.TrimSpace(c.cfg.Command) {
			t.Errorf("%s: Command = %q", c.name, got.Command)
		}
	}
}

func newWSLInitStore(t *testing.T) *settingsStore {
	t.Helper()
	st := &settingsStore{}
	st.load(t.TempDir())
	return st
}

func TestWSLInitPersistsLowercaseKey(t *testing.T) {
	st := newWSLInitStore(t)
	if err := st.setWSLInit("Ubuntu", WSLInitCfg{Enabled: true, Command: "init-wsl2"}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"Ubuntu", "ubuntu", "UBUNTU"} {
		c, ok := st.wslInitFor(name)
		if !ok || c.Command != "init-wsl2" || c.TimeoutSec != 300 {
			t.Fatalf("wslInitFor(%q) = %+v, %v", name, c, ok)
		}
	}
	if _, ok := st.wslInitFor("Debian"); ok {
		t.Fatal("Debian não tem configuração")
	}
	// relê do disco: a configuração sobrevive
	st2 := &settingsStore{}
	st2.load(st.dir)
	if c, ok := st2.wslInitFor("ubuntu"); !ok || c.Command != "init-wsl2" {
		t.Fatalf("depois de reler: %+v, %v", c, ok)
	}
	if err := st.setWSLInit("a b", WSLInitCfg{Command: "x"}); err == nil {
		t.Fatal("distro inválida deveria ser recusada")
	}
}

func TestImportWSLDistrosFile(t *testing.T) {
	st := newWSLInitStore(t)
	dir := t.TempDir()
	body := append([]byte{0xEF, 0xBB, 0xBF}, []byte(`{"Ubuntu":{"init":"init-wsl2","user":"root","timeout_sec":120},"Alpine":{"init":""}}`)...)
	path := filepath.Join(dir, "wsl-distros.json")
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatal(err)
	}
	// uma distro que já tem configuração não é sobrescrita
	if err := st.setWSLInit("Alpine", WSLInitCfg{Enabled: true, Command: "meu-comando"}); err != nil {
		t.Fatal(err)
	}
	importWSLDistrosFile(dir, st)
	c, ok := st.wslInitFor("ubuntu")
	if !ok || !c.Enabled || c.Command != "init-wsl2" || c.TimeoutSec != 120 {
		t.Fatalf("ubuntu = %+v, %v", c, ok)
	}
	if c, _ := st.wslInitFor("alpine"); c.Command != "meu-comando" {
		t.Fatalf("config existente foi sobrescrita: %+v", c)
	}
	if _, err := os.Stat(path); err == nil {
		t.Fatal("o arquivo deveria ter sido renomeado")
	}
	if _, err := os.Stat(path + ".migrado"); err != nil {
		t.Fatalf("falta wsl-distros.json.migrado: %v", err)
	}
	importWSLDistrosFile(dir, st) // sem arquivo: não faz nada nem quebra
}

func wslInitReq(t *testing.T, h http.Handler, method string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body != nil {
		b, _ := json.Marshal(body)
		r = httptest.NewRequest(method, "/api/wsl-init", bytes.NewReader(b))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = httptest.NewRequest(method, "/api/wsl-init", nil)
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, r)
	return rr
}

func TestWSLInitEndpoint(t *testing.T) {
	st := newWSLInitStore(t)
	h := wslInitHandler(st, func() []string { return []string{"Ubuntu", "Debian"} }, false)

	rr := wslInitReq(t, h, "GET", nil)
	var got struct {
		Distros []string              `json:"distros"`
		Config  map[string]WSLInitCfg `json:"config"`
	}
	if rr.Code != 200 || json.Unmarshal(rr.Body.Bytes(), &got) != nil || len(got.Distros) != 2 || len(got.Config) != 0 {
		t.Fatalf("GET = %d %s", rr.Code, rr.Body.String())
	}

	bad := wslInitReq(t, h, "POST", map[string]any{"distro": "Ubuntu", "config": WSLInitCfg{Enabled: true, Command: "a\nb"}})
	if bad.Code != 400 || !strings.Contains(bad.Body.String(), "error") {
		t.Fatalf("POST inválido = %d %s", bad.Code, bad.Body.String())
	}
	if _, ok := st.wslInitFor("ubuntu"); ok {
		t.Fatal("configuração inválida foi gravada")
	}

	ok := wslInitReq(t, h, "POST", map[string]any{"distro": "Ubuntu", "config": WSLInitCfg{Enabled: true, Command: "init-wsl2", TimeoutSec: 200}})
	if ok.Code != 200 {
		t.Fatalf("POST válido = %d %s", ok.Code, ok.Body.String())
	}
	if json.Unmarshal(ok.Body.Bytes(), &got) != nil || got.Config["ubuntu"].Command != "init-wsl2" || got.Config["ubuntu"].TimeoutSec != 200 {
		t.Fatalf("resposta = %s", ok.Body.String())
	}

	if rr := wslInitReq(t, h, "DELETE", nil); rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("DELETE = %d", rr.Code)
	}
}

func TestWSLInitEndpointReadOnlyAndContentType(t *testing.T) {
	st := newWSLInitStore(t)
	ro := wslInitHandler(st, func() []string { return nil }, true)
	rr := wslInitReq(t, ro, "POST", map[string]any{"distro": "Ubuntu", "config": WSLInitCfg{Command: "x"}})
	if rr.Code != http.StatusForbidden {
		t.Fatalf("somente leitura: POST = %d", rr.Code)
	}
	if rr := wslInitReq(t, ro, "GET", nil); rr.Code != 200 {
		t.Fatalf("somente leitura: GET = %d", rr.Code)
	}
	rw := wslInitHandler(st, func() []string { return nil }, false)
	r := httptest.NewRequest("POST", "/api/wsl-init", bytes.NewBufferString(`{}`))
	r.Header.Set("Content-Type", "text/plain")
	out := httptest.NewRecorder()
	rw.ServeHTTP(out, r)
	if out.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("content-type errado = %d", out.Code)
	}
}

func TestWSLInitTestEndpoint(t *testing.T) {
	st := newWSLInitStore(t)
	var started []string
	h := wslInitTestHandler(st, false, func(distro string, cfg WSLInitCfg) { started = append(started, distro+"|"+cfg.Command) })
	post := func(handler http.Handler, body string) int {
		r := httptest.NewRequest("POST", "/api/wsl-init/test", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, r)
		return rr.Code
	}
	if code := post(h, `{"distro":"Ubuntu"}`); code != http.StatusBadRequest || len(started) != 0 {
		t.Fatalf("sem comando configurado = %d started=%v", code, started)
	}
	if err := st.setWSLInit("Ubuntu", WSLInitCfg{Enabled: true, Command: "init-wsl2"}); err != nil {
		t.Fatal(err)
	}
	if code := post(h, `{"distro":"Ubuntu"}`); code != http.StatusAccepted || len(started) != 1 || started[0] != "Ubuntu|init-wsl2" {
		t.Fatalf("configurado = %d started=%v", code, started)
	}
	if code := post(h, `{"distro":"a b"}`); code != http.StatusBadRequest {
		t.Fatalf("distro inválida = %d", code)
	}
	if code := post(wslInitTestHandler(st, true, func(string, WSLInitCfg) {}), `{"distro":"Ubuntu"}`); code != http.StatusForbidden {
		t.Fatalf("somente leitura = %d", code)
	}
}

func TestImportWSLDistrosFileKeepsTheFileWhenAnEntryFails(t *testing.T) {
	st := newWSLInitStore(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "wsl-distros.json")
	body := `{"Ubuntu":{"init":"init-wsl2"},"Debian":{"init":"echo a\nb"}}`
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	importWSLDistrosFile(dir, st)
	if _, ok := st.wslInitFor("ubuntu"); !ok {
		t.Fatal("a entrada boa deveria ser importada")
	}
	if _, ok := st.wslInitFor("debian"); ok {
		t.Fatal("init com quebra de linha não deve ser importado")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("com uma entrada que falhou o arquivo deve ficar onde está: %v", err)
	}
}

func TestImportWSLDistrosFileTrimsTheKey(t *testing.T) {
	st := newWSLInitStore(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "wsl-distros.json"), []byte(`{" Ubuntu ":{"init":"init-wsl2"}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	importWSLDistrosFile(dir, st)
	if c, ok := st.wslInitFor("ubuntu"); !ok || c.Command != "init-wsl2" {
		t.Fatalf("a chave com espaços deveria ser aparada: %+v %v", c, ok)
	}
}
