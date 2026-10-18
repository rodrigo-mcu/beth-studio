package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"bethstudio-web/vpsinstall"
)

func withVPSStores(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("BETHSTUDIO_DATA_DIR", dir)
	oldK, oldP := secrets, phone
	secrets = &secretStore{}
	secrets.load(dir)
	phone = &phoneAuth{dir: dir, sessions: map[string]time.Time{}, now: time.Now}
	t.Cleanup(func() { secrets, phone = oldK, oldP })
}

type stubCF struct {
	vpsinstall.CFAPI
	verifyErr error
	zones     []vpsinstall.Zone
}

func (s stubCF) VerifyToken(context.Context) error { return s.verifyErr }
func (s stubCF) ListZones(context.Context) ([]vpsinstall.Zone, error) {
	return s.zones, nil
}

func vpsPost(srv *server, path string, body any) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(b)))
	rec := httptest.NewRecorder()
	srv.serveVPS(rec, r, "")
	return rec
}

func TestVPSRotasBloqueadasNoStudioRemoto(t *testing.T) {
	for _, p := range []string{"/api/vps/state", "/api/vps/install", "/api/vps/job", "/api/vps/action"} {
		for _, m := range []string{http.MethodGet, http.MethodPost} {
			if !remoteBlocked(p, m) {
				t.Errorf("%s %s deveria ser só do PC", m, p)
			}
		}
	}
	srv := &server{hub: newHub(false)}
	rec := httptest.NewRecorder()
	srv.serveVPS(rec, httptest.NewRequest(http.MethodGet, "/api/vps/state", nil), "chave-remota")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("com remoteKey: %d", rec.Code)
	}
}

func TestVPSCelularNaoEnxergaAsRotas(t *testing.T) {
	tok := withPhoneSession(t)
	srv := &server{hub: newHub(false)}
	for _, p := range []string{"/api/vps/state", "/api/vps/install", "/api/vps/job?id=x"} {
		for _, m := range []string{http.MethodGet, http.MethodPost} {
			rec := httptest.NewRecorder()
			srv.servePhonePublic(rec, phoneReq(m, p, tok))
			if rec.Code != http.StatusNotFound {
				t.Errorf("celular logado: %s %s deveria ser 404, veio %d", m, p, rec.Code)
			}
			rec = httptest.NewRecorder()
			srv.servePhonePublic(rec, phoneReq(m, p, ""))
			if rec.Code != http.StatusNotFound && rec.Code != http.StatusUnauthorized {
				t.Errorf("celular sem login: %s %s: %d", m, p, rec.Code)
			}
		}
	}
}

func TestVPSValidacoes(t *testing.T) {
	withVPSStores(t)
	srv := &server{hub: newHub(false)}
	rec := vpsPost(srv, "/api/vps/probe", map[string]any{"host": "x;rm -rf /", "port": 22})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("host malicioso: %d %s", rec.Code, rec.Body.String())
	}
	rec = vpsPost(srv, "/api/vps/install", map[string]any{
		"host": "203.0.113.9", "port": 22, "user": "root; id", "password": "x", "fingerprint": "SHA256:x",
		"domain": "a.exemplo.com", "zone_id": "aaa", "zone_name": "exemplo.com", "cf_token": "t", "phone_password": "12345678",
	})
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "usuário") {
		t.Fatalf("usuário malicioso: %d %s", rec.Code, rec.Body.String())
	}
	rec = vpsPost(srv, "/api/vps/install", map[string]any{
		"host": "203.0.113.9", "user": "root", "password": "x", "fingerprint": "SHA256:x",
		"domain": "a.outro.com", "zone_id": "aaa", "zone_name": "exemplo.com", "cf_token": "t", "phone_password": "12345678",
	})
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "zona") {
		t.Fatalf("domínio fora da zona: %d %s", rec.Code, rec.Body.String())
	}
	rec = vpsPost(srv, "/api/vps/action", map[string]any{"action": "apagar-tudo"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("ação desconhecida: %d", rec.Code)
	}
	r := httptest.NewRequest(http.MethodGet, "/api/vps/install", nil)
	rec = httptest.NewRecorder()
	srv.serveVPS(rec, r, "")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET em rota de escrita: %d", rec.Code)
	}
}

func TestVPSSomenteLeitura(t *testing.T) {
	withVPSStores(t)
	srv := &server{hub: newHub(true)}
	if rec := vpsPost(srv, "/api/vps/install", map[string]any{}); rec.Code != http.StatusForbidden {
		t.Fatalf("%d", rec.Code)
	}
}

func TestVPSPlanoEZonas(t *testing.T) {
	withVPSStores(t)
	srv := &server{hub: newHub(false)}
	rec := vpsPost(srv, "/api/vps/plan", map[string]any{"domain": "a.exemplo.com", "port": 2222, "unattended": true})
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "reverse_proxy 127.0.0.1:8787") {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}

	old := vpsCF
	t.Cleanup(func() { vpsCF = old })
	vpsCF = func(string) vpsinstall.CFAPI {
		return stubCF{zones: []vpsinstall.Zone{{ID: "aaa111", Name: "exemplo.com", Status: "active"}}}
	}
	rec = vpsPost(srv, "/api/vps/cf/zones", map[string]any{"cf_token": "tok"})
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "exemplo.com") {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "tok\"") {
		t.Fatal("token na resposta")
	}
	vpsCF = func(string) vpsinstall.CFAPI { return stubCF{verifyErr: errors.New("token sem permissão")} }
	rec = vpsPost(srv, "/api/vps/cf/zones", map[string]any{"cf_token": "tok"})
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "token sem permissão") {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

func TestVPSEstadoNaoTemSegredos(t *testing.T) {
	withVPSStores(t)
	if err := vpsStore().Save(vpsinstall.Server{Host: "203.0.113.9", Port: 22, User: "root", Domain: "a.exemplo.com", Fingerprint: "SHA256:x"}); err != nil {
		t.Fatal(err)
	}
	srv := &server{hub: newHub(false)}
	rec := httptest.NewRecorder()
	srv.serveVPS(rec, httptest.NewRequest(http.MethodGet, "/api/vps/state", nil), "")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "a.exemplo.com") {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

func TestVPSJobInexistente(t *testing.T) {
	srv := &server{hub: newHub(false)}
	rec := httptest.NewRecorder()
	srv.serveVPS(rec, httptest.NewRequest(http.MethodGet, "/api/vps/job?id=nao-existe", nil), "")
	if rec.Code != http.StatusNotFound {
		t.Fatal(rec.Code)
	}
}

func TestStudioHookPareamento(t *testing.T) {
	withVPSStores(t)
	h := studioHook{}
	if h.PhoneConfigured() {
		t.Fatal("sem senha ainda")
	}
	if err := h.ApplyPairing("a.exemplo.com", strings.Repeat("a", 64), ""); err == nil {
		t.Fatal("sem senha do celular deveria falhar")
	}
	if err := h.ApplyPairing("a.exemplo.com", strings.Repeat("a", 64), "senha-do-celular"); err != nil {
		t.Fatal(err)
	}
	if d, ok := phone.configured(); !ok || d != "a.exemplo.com" || !h.PhoneConfigured() {
		t.Fatal("deveria estar pareado")
	}
	if err := h.ApplyPairing("x y", strings.Repeat("a", 64), ""); err == nil {
		t.Fatal("domínio inválido")
	}
	if err := h.ClearPairing(); err != nil {
		t.Fatal(err)
	}
	if _, ok := phone.configured(); ok {
		t.Fatal("pareamento deveria ter sido limpo")
	}
	if !h.PhoneConfigured() {
		t.Fatal("a senha do celular continua")
	}
}
