package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestUpdateBaseIgnoraAmbienteEmProducao(t *testing.T) {
	prev := updateTestBase
	updateTestBase = ""
	t.Cleanup(func() { updateTestBase = prev })
	t.Setenv("BETHSTUDIO_UPDATE_BASE", "http://127.0.0.1:9")
	if got := updateAPIRoot(); got != "https://api.github.com" {
		t.Fatalf("a cópia normal leu a variável de teste: %s", got)
	}
	if err := setUpdateTestBase("https://github.com"); err == nil {
		t.Fatal("base de teste aceitou https fora de 127.0.0.1")
	}
	if err := setUpdateTestBase("http://example.com:80"); err == nil {
		t.Fatal("base de teste aceitou outro host")
	}
	u, _ := url.Parse("https://github.com/rodrigo-mcu/beth-studio/releases/download/v0.2.0/BethStudio-ui-0.2.0.zip")
	if updateURLAllowed(u) != (updateTestBase == "") {
		t.Fatal("allowlist de produção mudou com a base de teste vazia")
	}
	for _, raw := range []string{
		"https://api.github.com/repos/rodrigo-mcu/beth-studio/releases",
		"https://objects.githubusercontent.com/github-production-release-asset/1",
		"https://release-assets.githubusercontent.com/github-production-release-asset/1",
		"https://github-releases.githubusercontent.com/1",
	} {
		pu, err := url.Parse(raw)
		if err != nil || !updateURLAllowed(pu) {
			t.Fatalf("host oficial recusado: %s", raw)
		}
	}
	evil, _ := url.Parse("https://example.com/BethStudio-Setup.exe")
	if updateURLAllowed(evil) {
		t.Fatal("host estranho foi aceito")
	}
	plain, _ := url.Parse("http://github.com/x")
	if updateURLAllowed(plain) {
		t.Fatal("http fora do teste foi aceito")
	}
}

func TestUpdateCheckCenarios(t *testing.T) {
	withAppVersion(t, "0.1.0")

	t.Run("sem atualização", func(t *testing.T) {
		withAppVersion(t, "0.2.0")
		h := newFakeReleases(t)
		h.addStable("0.2.0", nil)
		res := h.check(t, false)
		if res.Code != 200 || res.update || !strings.Contains(res.msg, "Não há versão mais nova") {
			t.Fatalf("%d %s", res.Code, res.raw)
		}
	})

	t.Run("rascunho e pré-lançamento ignorados", func(t *testing.T) {
		h := newFakeReleases(t)
		h.add("9.0.0", true, false, nil)
		h.add("8.0.0", false, true, nil)
		h.addStable("0.2.0", nil)
		res := h.check(t, false)
		if !res.update || res.j["latest"] != "0.2.0" {
			t.Fatalf("escolheu release errado: %s", res.raw)
		}
	})

	t.Run("só rascunho", func(t *testing.T) {
		h := newFakeReleases(t)
		h.add("9.0.0", true, false, nil)
		h.add("8.0.0", false, true, nil)
		res := h.check(t, false)
		if res.update || res.j["latest"] != "" && res.j["latest"] != nil {
			t.Fatalf("rascunho contou como atualização: %s", res.raw)
		}
		if !strings.Contains(res.msg, "Não há versão mais nova") && !strings.Contains(res.msg, "Não há release") {
			t.Fatalf("mensagem: %s", res.msg)
		}
	})

	t.Run("falha de rede", func(t *testing.T) {
		if err := setUpdateTestBase("http://127.0.0.1:1"); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { updateTestBase = "" })
		clearUpdateCache()
		rr := studioUpdate(t, false, http.MethodGet, "/api/update/check", "")
		if rr.Code < 400 || !strings.Contains(rr.Body.String(), "GitHub") {
			t.Fatalf("%d %s", rr.Code, rr.Body.String())
		}
	})

	t.Run("limite 403", func(t *testing.T) {
		h := newFakeReleases(t)
		h.apiStatus = http.StatusForbidden
		res := h.check(t, false)
		if res.Code < 400 || !strings.Contains(strings.ToLower(res.raw), "limitou") {
			t.Fatalf("%d %s", res.Code, res.raw)
		}
	})

	t.Run("limite 429", func(t *testing.T) {
		h := newFakeReleases(t)
		h.apiStatus = http.StatusTooManyRequests
		res := h.check(t, false)
		if res.Code < 400 || !strings.Contains(strings.ToLower(res.raw), "limitou") {
			t.Fatalf("%d %s", res.Code, res.raw)
		}
	})

	t.Run("somente leitura não instala", func(t *testing.T) {
		h := newFakeReleases(t)
		h.addStable("0.2.0", map[string][]byte{"BethStudio-ui-0.2.0.zip": zipUI(t, "0.2.0", 1, "nova")})
		res := h.check(t, true)
		if !res.update || res.j["can_install"] != false {
			t.Fatalf("somente leitura: %s", res.raw)
		}
		rr := studioUpdate(t, true, http.MethodPost, "/api/update/apply-ui", `{"confirm":true}`)
		if rr.Code != http.StatusForbidden {
			t.Fatalf("apply em somente leitura: %d %s", rr.Code, rr.Body.String())
		}
	})

	t.Run("dev não quebra", func(t *testing.T) {
		withAppVersion(t, "dev")
		h := newFakeReleases(t)
		h.addStable("0.2.0", nil)
		res := h.check(t, false)
		if !res.update || res.j["latest"] != "0.2.0" {
			t.Fatalf("dev: %s", res.raw)
		}
	})

	t.Run("cache e etag", func(t *testing.T) {
		h := newFakeReleases(t)
		h.addStable("0.2.0", nil)
		if !h.check(t, false).update {
			t.Fatal("primeira consulta")
		}
		if !h.check(t, false).update {
			t.Fatal("segunda consulta")
		}
		if h.apiHits != 1 {
			t.Fatalf("cache não segurou a segunda consulta: %d", h.apiHits)
		}
		updateCacheMu.Lock()
		updateCachedAt = time.Now().Add(-10 * time.Minute)
		updateCacheMu.Unlock()
		if !h.check(t, false).update {
			t.Fatal("consulta com 304")
		}
		if h.apiHits != 2 || h.sawIfNone == "" {
			t.Fatalf("If-None-Match não foi enviado (hits=%d etag=%q)", h.apiHits, h.sawIfNone)
		}
	})

	t.Run("sem autorização", func(t *testing.T) {
		h := newFakeReleases(t)
		h.addStable("0.2.0", nil)
		h.check(t, false)
		if h.sawAuth {
			t.Fatal("a consulta mandou Authorization")
		}
		if h.sawUA == "" {
			t.Fatal("faltou User-Agent")
		}
	})
}

func TestUpdateApplyUI(t *testing.T) {
	withAppVersion(t, "0.1.0")
	dir := t.TempDir()
	t.Setenv("BETHSTUDIO_DATA_DIR", dir)
	writeUIPkg(t, filepath.Join(dir, "ui", "current"), `{"version":"0.1.0","requires_api":1}`, "velha")

	t.Run("sha certo", func(t *testing.T) {
		clearUpdateCache()
		h := newFakeReleases(t)
		body := zipUI(t, "0.2.0", 1, "nova")
		h.addStable("0.2.0", map[string][]byte{
			"BethStudio-ui-0.2.0.zip": body,
			"BethStudio-Setup.exe":    []byte("MZ-falso"),
		})
		rr := studioUpdate(t, false, http.MethodPost, "/api/update/apply-ui", `{"confirm":true}`)
		if rr.Code != 200 {
			t.Fatalf("apply: %d %s", rr.Code, rr.Body.String())
		}
		got, err := os.ReadFile(filepath.Join(dir, "ui", "current", "index.html"))
		if err != nil || string(got) != "nova" {
			t.Fatalf("current: %v %q", err, got)
		}
		prev, err := os.ReadFile(filepath.Join(dir, "ui", "previous", "index.html"))
		if err != nil || string(prev) != "velha" {
			t.Fatalf("previous: %v %q", err, prev)
		}
		resetUICache()
		if u := currentUI(); !u.Override || u.Version != "0.2.0" {
			t.Fatalf("override: %+v", u)
		}
	})

	t.Run("sha errado", func(t *testing.T) {
		clearUpdateCache()
		h := newFakeReleases(t)
		h.badSum = true
		h.addStable("0.3.0", map[string][]byte{"BethStudio-ui-0.3.0.zip": zipUI(t, "0.3.0", 1, "ruim")})
		rr := studioUpdate(t, false, http.MethodPost, "/api/update/apply-ui", `{"confirm":true}`)
		if rr.Code == 200 || !strings.Contains(strings.ToLower(rr.Body.String()), "não confere") {
			t.Fatalf("sha errado: %d %s", rr.Code, rr.Body.String())
		}
		got, _ := os.ReadFile(filepath.Join(dir, "ui", "current", "index.html"))
		if string(got) == "ruim" {
			t.Fatal("pacote com sha errado foi aplicado")
		}
	})

	t.Run("requires_api maior", func(t *testing.T) {
		clearUpdateCache()
		h := newFakeReleases(t)
		h.addStable("0.4.0", map[string][]byte{"BethStudio-ui-0.4.0.zip": zipUI(t, "0.4.0", 999, "futura")})
		rr := studioUpdate(t, false, http.MethodPost, "/api/update/apply-ui", `{"confirm":true}`)
		if rr.Code == 200 || !strings.Contains(rr.Body.String(), "Studio mais novo") {
			t.Fatalf("api: %d %s", rr.Code, rr.Body.String())
		}
		got, _ := os.ReadFile(filepath.Join(dir, "ui", "current", "index.html"))
		if string(got) == "futura" {
			t.Fatal("pacote incompatível foi aplicado")
		}
	})

	t.Run("redirecionamento estranho", func(t *testing.T) {
		clearUpdateCache()
		h := newFakeReleases(t)
		h.redirectTo = "http://example.com/pacote.zip"
		h.addStable("0.5.0", map[string][]byte{"BethStudio-ui-0.5.0.zip": zipUI(t, "0.5.0", 1, "redir")})
		rr := studioUpdate(t, false, http.MethodPost, "/api/update/apply-ui", `{"confirm":true}`)
		if rr.Code == 200 || !strings.Contains(rr.Body.String(), "GitHub") {
			t.Fatalf("redirect: %d %s", rr.Code, rr.Body.String())
		}
	})

	t.Run("sem confirmação", func(t *testing.T) {
		clearUpdateCache()
		h := newFakeReleases(t)
		h.addStable("0.6.0", map[string][]byte{"BethStudio-ui-0.6.0.zip": zipUI(t, "0.6.0", 1, "nao")})
		rr := studioUpdate(t, false, http.MethodPost, "/api/update/apply-ui", `{}`)
		if rr.Code == 200 {
			t.Fatalf("aplicou sem confirm: %s", rr.Body.String())
		}
		if h.dlHits != 0 {
			t.Fatal("baixou sem confirmação")
		}
	})

	t.Run("redirecionamento no mesmo servidor", func(t *testing.T) {
		clearUpdateCache()
		h := newFakeReleases(t)
		h.hop = true
		h.addStable("0.8.0", map[string][]byte{"BethStudio-ui-0.8.0.zip": zipUI(t, "0.8.0", 1, "via-hop")})
		rr := studioUpdate(t, false, http.MethodPost, "/api/update/apply-ui", `{"confirm":true}`)
		if rr.Code != 200 {
			t.Fatalf("hop: %d %s", rr.Code, rr.Body.String())
		}
		got, err := os.ReadFile(filepath.Join(dir, "ui", "current", "index.html"))
		if err != nil || string(got) != "via-hop" {
			t.Fatalf("hop current: %v %q", err, got)
		}
	})

	t.Run("zip slip", func(t *testing.T) {
		clearUpdateCache()
		h := newFakeReleases(t)
		h.addStable("0.7.0", map[string][]byte{"BethStudio-ui-0.7.0.zip": zipSlip(t)})
		rr := studioUpdate(t, false, http.MethodPost, "/api/update/apply-ui", `{"confirm":true}`)
		if rr.Code == 200 {
			t.Fatalf("aceitou zip slip: %s", rr.Body.String())
		}
		if _, err := os.Stat(filepath.Join(dir, "fora.txt")); err == nil {
			t.Fatal("arquivo escapou da pasta de staging")
		}
		if _, err := os.Stat(filepath.Join(dir, "ui", "fora.txt")); err == nil {
			t.Fatal("arquivo escapou para a pasta da interface")
		}
	})
}

func TestUpdateSetupNaoExecutaSozinho(t *testing.T) {
	withAppVersion(t, "0.1.0")
	t.Setenv("BETHSTUDIO_DATA_DIR", t.TempDir())
	clearUpdateCache()
	var launched, revealed string
	prevL, prevR := updateLaunch, updateReveal
	updateLaunch = func(path string) error { launched = path; return nil }
	updateReveal = func(path string, exists bool) error { revealed = path; return nil }
	t.Cleanup(func() { updateLaunch, updateReveal = prevL, prevR })

	exe := []byte("MZ-instalador-falso")
	h := newFakeReleases(t)
	h.addStable("0.2.0", map[string][]byte{
		"BethStudio-ui-0.2.0.zip": zipUI(t, "0.2.0", 1, "ui"),
		"BethStudio-Setup.exe":    exe,
	})
	rr := studioUpdate(t, false, http.MethodPost, "/api/update/prepare-setup", `{"confirm":true}`)
	if rr.Code != 200 || launched != "" {
		t.Fatalf("prepare executou ou falhou: %d %s launch=%q", rr.Code, rr.Body.String(), launched)
	}
	var got map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &got)
	path, _ := got["path"].(string)
	if path == "" {
		t.Fatalf("sem caminho: %s", rr.Body.String())
	}
	onDisk, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(onDisk, exe) {
		t.Fatalf("exe em disco: %v", err)
	}
	rr = studioUpdate(t, false, http.MethodPost, "/api/update/open-setup", `{"confirm":false,"action":"launch"}`)
	if rr.Code == 200 || launched != "" {
		t.Fatalf("abriu sem confirm: %d %s", rr.Code, rr.Body.String())
	}
	rr = studioUpdate(t, false, http.MethodPost, "/api/update/open-setup", `{"confirm":true,"action":"reveal"}`)
	if rr.Code != 200 || revealed == "" {
		t.Fatalf("reveal: %d %s", rr.Code, rr.Body.String())
	}
	rr = studioUpdate(t, false, http.MethodPost, "/api/update/open-setup", `{"confirm":true,"action":"launch"}`)
	if rr.Code != 200 || launched != path {
		t.Fatalf("launch: %d %s got=%q", rr.Code, rr.Body.String(), launched)
	}
	if err := os.WriteFile(path, []byte("trocado"), 0o644); err != nil {
		t.Fatal(err)
	}
	launched = ""
	rr = studioUpdate(t, false, http.MethodPost, "/api/update/open-setup", `{"confirm":true,"action":"launch"}`)
	if rr.Code == 200 || launched != "" {
		t.Fatalf("executou exe adulterado: %d %s", rr.Code, rr.Body.String())
	}
}

func TestRemoteBlockedUpdate(t *testing.T) {
	if remoteBlocked("/api/update/check", http.MethodGet) {
		t.Fatal("consultar pelo Studio remoto é só leitura")
	}
	for _, p := range []string{"/api/update/apply-ui", "/api/update/prepare-setup", "/api/update/open-setup"} {
		if !remoteBlocked(p, http.MethodPost) {
			t.Fatalf("%s deveria ficar só no PC", p)
		}
	}
}

type checkRes struct {
	Code   int
	raw    string
	msg    string
	update bool
	j      map[string]any
}

type fakeRel struct {
	tag   string
	draft bool
	pre   bool
	files map[string][]byte
}

type fakeReleases struct {
	mu         sync.Mutex
	rels       []fakeRel
	apiStatus  int
	badSum     bool
	redirectTo string
	hop        bool
	apiHits    int
	dlHits     int
	sawAuth    bool
	sawUA      string
	sawIfNone  string
	etag       string
	url        string
}

func newFakeReleases(t *testing.T) *fakeReleases {
	t.Helper()
	h := &fakeReleases{etag: `"teste-1"`}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	if err := setUpdateTestBase(srv.URL); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { updateTestBase = "" })
	clearUpdateCache()
	h.url = srv.URL
	return h
}

func (h *fakeReleases) add(tag string, draft, pre bool, files map[string][]byte) {
	h.rels = append(h.rels, fakeRel{tag: tag, draft: draft, pre: pre, files: files})
}

func (h *fakeReleases) addStable(tag string, files map[string][]byte) {
	h.add(tag, false, false, files)
}

func (h *fakeReleases) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r.Header.Get("Authorization") != "" {
		h.sawAuth = true
	}
	if ua := r.Header.Get("User-Agent"); ua != "" {
		h.sawUA = ua
	}
	if strings.Contains(r.URL.Path, "/releases") {
		h.apiHits++
		if h.apiStatus != 0 {
			http.Error(w, "limite", h.apiStatus)
			return
		}
		if inm := r.Header.Get("If-None-Match"); inm != "" {
			h.sawIfNone = inm
			if inm == h.etag {
				w.WriteHeader(http.StatusNotModified)
				return
			}
		}
		w.Header().Set("ETag", h.etag)
		var list []map[string]any
		for _, rel := range h.rels {
			var assets []map[string]any
			for name := range rel.files {
				assets = append(assets, map[string]any{
					"name":                 name,
					"browser_download_url": h.url + "/download/" + name,
					"size":                 len(rel.files[name]),
				})
			}
			if rel.files != nil {
				assets = append(assets, map[string]any{
					"name":                 "SHA256SUMS.txt",
					"browser_download_url": h.url + "/download/SHA256SUMS.txt?tag=v" + rel.tag,
					"size":                 64,
				})
			}
			list = append(list, map[string]any{
				"tag_name":   "v" + rel.tag,
				"draft":      rel.draft,
				"prerelease": rel.pre,
				"assets":     assets,
			})
		}
		_ = json.NewEncoder(w).Encode(list)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/download/") || strings.HasPrefix(r.URL.Path, "/file/") {
		h.dlHits++
		if strings.HasPrefix(r.URL.Path, "/download/") && h.redirectTo != "" {
			http.Redirect(w, r, h.redirectTo, http.StatusFound)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/download/") && h.hop {
			http.Redirect(w, r, h.url+"/file"+strings.TrimPrefix(r.URL.RequestURI(), "/download"), http.StatusFound)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/download/")
		name = strings.TrimPrefix(name, "/file/")
		if name == "SHA256SUMS.txt" {
			tag := strings.TrimPrefix(r.URL.Query().Get("tag"), "v")
			_, _ = io.WriteString(w, h.sums(tag))
			return
		}
		for _, rel := range h.rels {
			if b, ok := rel.files[name]; ok {
				_, _ = w.Write(b)
				return
			}
		}
	}
	http.NotFound(w, r)
}

func (h *fakeReleases) sums(tag string) string {
	var b strings.Builder
	for _, rel := range h.rels {
		if rel.tag != tag {
			continue
		}
		for name, body := range rel.files {
			sum := sha256.Sum256(body)
			hexSum := hex.EncodeToString(sum[:])
			if h.badSum {
				hexSum = strings.Repeat("ab", 32)
			}
			b.WriteString(hexSum + "  " + name + "\n")
		}
	}
	return b.String()
}

func (h *fakeReleases) check(t *testing.T, readOnly bool) checkRes {
	t.Helper()
	rr := studioUpdate(t, readOnly, http.MethodGet, "/api/update/check", "")
	var j map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &j)
	msg, _ := j["message"].(string)
	if e, _ := j["error"].(string); e != "" {
		msg = e
	}
	up, _ := j["update"].(bool)
	return checkRes{Code: rr.Code, raw: rr.Body.String(), msg: msg, update: up, j: j}
}

func studioUpdate(t *testing.T, readOnly bool, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	srv := newServer("tok", 5555, "", newHub(readOnly))
	req := httptest.NewRequest(method, "http://127.0.0.1:5555"+path, strings.NewReader(body))
	req.Host = "127.0.0.1:5555"
	req.Header.Set(tokenHeader, "tok")
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	return rr
}

func withAppVersion(t *testing.T, v string) {
	t.Helper()
	prev := appVersion
	appVersion = v
	t.Cleanup(func() { appVersion = prev })
}

func zipUI(t *testing.T, version string, requires int, index string) []byte {
	t.Helper()
	sum := sha256.Sum256([]byte(index))
	manifest := map[string]any{
		"version":      version,
		"requires_api": requires,
		"files":        map[string]string{"index.html": hex.EncodeToString(sum[:])},
	}
	mb, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	return mustZip(t, map[string]string{"index.html": index, "ui.json": string(mb)})
}

func zipSlip(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	f, err := w.Create("../fora.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.WriteString(f, "escapou")
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func mustZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, body := range files {
		f, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(f, body); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
