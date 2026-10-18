package main

import (
	"encoding/base32"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// Vetores do RFC 6238 (SHA-1), com 6 dígitos.
func TestTOTPRFC6238(t *testing.T) {
	sec := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString([]byte("12345678901234567890"))
	key, err := totpKey(sec)
	if err != nil {
		t.Fatal(err)
	}
	for ts, want := range map[int64]string{59: "287082", 1111111109: "081804", 1234567890: "005924", 2000000000: "279037"} {
		if got := totpAt(key, totpCounter(time.Unix(ts, 0))); got != want {
			t.Fatalf("t=%d: %s, queria %s", ts, got, want)
		}
	}
	if _, ok := totpCheck(sec, "287082", time.Unix(59+30, 0)); !ok {
		t.Fatal("um passo de atraso devia valer")
	}
	if _, ok := totpCheck(sec, "287082", time.Unix(59+90, 0)); ok {
		t.Fatal("três passos depois não vale")
	}
	if _, ok := totpCheck(sec, "28708", time.Unix(59, 0)); ok {
		t.Fatal("5 dígitos")
	}
	if !strings.HasPrefix(totpURI(sec, "x.com"), "otpauth://totp/Beth%20Studio:x.com?") {
		t.Fatal(totpURI(sec, "x.com"))
	}
}

func TestLoginLimiter(t *testing.T) {
	now := time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)
	l := &loginLimiter{now: func() time.Time { return now }}
	for i := 0; i < 4; i++ {
		if l.fail("a") {
			t.Fatal("travou cedo")
		}
	}
	if !l.fail("a") || l.check("a") == nil {
		t.Fatal("5º erro devia travar")
	}
	if l.check("b") != nil {
		t.Fatal("outro IP não trava")
	}
	now = now.Add(61 * time.Second)
	if l.check("a") != nil {
		t.Fatal("1 minuto passou")
	}
	for i := 0; i < 5; i++ {
		l.fail("a")
	}
	if err := l.check("a"); err == nil || !strings.Contains(err.Error(), "2 minutos") {
		t.Fatalf("segunda trava dobra: %v", err)
	}
	// Geral: 30 erros em 10 min, de IPs diferentes, travam todos.
	g := &loginLimiter{now: func() time.Time { return now }}
	for i := 0; i < limitGlobalMax; i++ {
		g.fail("ip" + string(rune('A'+i)))
	}
	if g.check("novo") == nil {
		t.Fatal("trava geral")
	}
	now = now.Add(limitGlobalSpan + time.Second)
	if g.check("novo") != nil {
		t.Fatal("janela passou")
	}
}

const testTOTP = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"

func codeNow(t *testing.T, at time.Time) string {
	t.Helper()
	key, err := totpKey(testTOTP)
	if err != nil {
		t.Fatal(err)
	}
	return totpAt(key, totpCounter(at))
}

// withRemote: celular com senha "senha-certa", Studio remoto ligado.
func withRemote(t *testing.T, now *time.Time) {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte("senha-certa"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	oldP, oldR := phone, remote
	clock := func() time.Time { return *now }
	phone = &phoneAuth{domain: testDomain, secret: "segredo", hash: hash, now: clock}
	remote = &remoteAuth{
		enabled:  true,
		totp:     testTOTP,
		sessions: map[string]*remoteSession{},
		limit:    &loginLimiter{now: clock},
		now:      clock,
	}
	t.Cleanup(func() { phone, remote = oldP, oldR })
}

func TestRemoteLogin(t *testing.T) {
	now := time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)
	withRemote(t, &now)
	if _, err := remote.login("1.1.1.1", "ua", "senha-certa", "000000"); err == nil {
		t.Fatal("código errado")
	}
	if _, err := remote.login("1.1.1.1", "ua", "errada", codeNow(t, now)); err == nil || err.Error() != "senha ou código incorreto" {
		t.Fatalf("senha errada: %v", err)
	}
	tok, err := remote.login("1.1.1.1", "ua", "senha-certa", codeNow(t, now))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := remote.login("1.1.1.1", "ua", "senha-certa", codeNow(t, now)); err == nil {
		t.Fatal("o mesmo código não vale duas vezes")
	}
	r := httptest.NewRequest(http.MethodGet, "/studio/", nil)
	r.AddCookie(&http.Cookie{Name: remoteCookie, Value: tok})
	key, ok := remote.session(r)
	if !ok {
		t.Fatal("sessão")
	}
	for k := range remote.sessions {
		if k == tok {
			t.Fatal("token guardado em texto puro")
		}
	}
	// 12 h sem uso fecha a sessão.
	now = now.Add(remoteIdle + time.Minute)
	if remote.valid(key) {
		t.Fatal("sessão parada devia expirar")
	}
	// Sessão nova, encerrada no PC.
	tok, err = remote.login("1.1.1.1", "ua", "senha-certa", codeNow(t, now))
	if err != nil {
		t.Fatal(err)
	}
	if remote.revoke("", "teste") == 0 {
		t.Fatal("revoke")
	}
	r = httptest.NewRequest(http.MethodGet, "/studio/", nil)
	r.AddCookie(&http.Cookie{Name: remoteCookie, Value: tok})
	if _, ok := remote.session(r); ok {
		t.Fatal("encerrada e ainda vale")
	}
}

func remoteReq(method, path, cookie string, origin bool) *http.Request {
	r := httptest.NewRequest(method, path, nil)
	if origin {
		r.Header.Set("Origin", "https://"+testDomain)
	}
	if cookie != "" {
		r.AddCookie(&http.Cookie{Name: remoteCookie, Value: cookie})
	}
	return r
}

func TestRemoteGate(t *testing.T) {
	now := time.Now()
	withRemote(t, &now)
	srv := &server{hub: newHub(false)}
	serve := func(r *http.Request) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		srv.servePhonePublic(rec, r)
		return rec
	}

	// Sem login: página vai para o login; API responde 401.
	if rec := serve(remoteReq(http.MethodGet, "/studio/", "", false)); rec.Code != http.StatusFound || rec.Header().Get("Location") != "/studio/login" {
		t.Fatalf("sem login: %d %s", rec.Code, rec.Header().Get("Location"))
	}
	if rec := serve(remoteReq(http.MethodGet, "/studio/api/settings", "", false)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("api sem login: %d", rec.Code)
	}
	if rec := serve(remoteReq(http.MethodGet, "/studio/login", "", false)); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `name="code"`) {
		t.Fatalf("página de login: %d", rec.Code)
	}

	// Login pelo formulário: sem origem é recusado; com origem entra.
	form := url.Values{"password": {"senha-certa"}, "code": {codeNow(t, now)}}.Encode()
	lr := httptest.NewRequest(http.MethodPost, "/studio/login", strings.NewReader(form))
	lr.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if rec := serve(lr); rec.Code != http.StatusForbidden {
		t.Fatalf("login sem origem: %d", rec.Code)
	}
	lr = httptest.NewRequest(http.MethodPost, "/studio/login", strings.NewReader(form))
	lr.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	lr.Header.Set("Origin", "https://"+testDomain)
	rec := serve(lr)
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("login: %d %s", rec.Code, rec.Body.String())
	}
	var tok string
	for _, c := range rec.Result().Cookies() {
		if c.Name == remoteCookie {
			tok = c.Value
			if c.Path != "/studio" || !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteStrictMode {
				t.Fatalf("cookie: %+v", c)
			}
		}
	}
	if tok == "" {
		t.Fatal("sem cookie")
	}

	// Com login: as rotas do Studio respondem.
	if rec := serve(remoteReq(http.MethodGet, "/studio/healthz", tok, false)); rec.Code != http.StatusOK {
		t.Fatalf("healthz: %d", rec.Code)
	}
	// no-referrer faria o navegador mandar "Origin: null" nos POSTs da página
	if got := rec.Header().Get("Referrer-Policy"); got != "same-origin" {
		t.Fatalf("Referrer-Policy: %q", got)
	}
	if got := rec.Header().Get("Content-Security-Policy"); strings.Contains(got, "127.0.0.1") {
		t.Fatalf("CSP: %s", got)
	}
	// O que só existe no PC.
	for _, p := range []string{"/api/remote", "/api/phone/setup", "/api/pick-folder", "/api/local-file/save-as", "/api/open-link", "/api/db/window", "/api/ssh/sftp/window"} {
		if rec := serve(remoteReq(http.MethodPost, "/studio"+p, tok, true)); rec.Code != http.StatusForbidden {
			t.Fatalf("%s pelo túnel: %d", p, rec.Code)
		}
	}
	// POST sem origem, mesmo com login.
	if rec := serve(remoteReq(http.MethodPost, "/studio/api/settings", tok, false)); rec.Code != http.StatusForbidden {
		t.Fatalf("POST sem origem: %d", rec.Code)
	}
	// WebSocket de outro site.
	ws := remoteReq(http.MethodGet, "/studio/ws", tok, false)
	ws.Header.Set("Origin", "https://outro.site")
	if rec := serve(ws); rec.Code != http.StatusForbidden {
		t.Fatalf("ws de outro site: %d", rec.Code)
	}

	// O cookie do celular não abre o Studio, e o do Studio não abre as rotas do celular.
	pr := httptest.NewRequest(http.MethodGet, "/studio/api/settings", nil)
	pr.AddCookie(&http.Cookie{Name: phoneCookie, Value: tok})
	if rec := serve(pr); rec.Code != http.StatusUnauthorized {
		t.Fatalf("cookie do celular no Studio: %d", rec.Code)
	}
	if rec := serve(remoteReq(http.MethodGet, "/api/settings", tok, false)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("rota do PC fora de /studio: %d", rec.Code)
	}

	// Desligado: nada passa, nem com sessão.
	remote.enabled = false
	if rec := serve(remoteReq(http.MethodGet, "/studio/healthz", tok, false)); rec.Code != http.StatusNotFound {
		t.Fatalf("desligado: %d", rec.Code)
	}
}

func TestRemoteBlockedAbout(t *testing.T) {
	if remoteBlocked("/api/about", http.MethodGet) {
		t.Fatal("GET /api/about é só leitura")
	}
	if !remoteBlocked("/api/about", http.MethodPost) {
		t.Fatal("POST /api/about abre o Explorer no PC")
	}
}
