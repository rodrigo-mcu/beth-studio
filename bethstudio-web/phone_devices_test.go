package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time { return c.t }

func newTestPhone(t *testing.T) (*phoneAuth, *fakeClock) {
	t.Helper()
	clk := &fakeClock{t: time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)}
	a := &phoneAuth{
		dir:    t.TempDir(),
		domain: testDomain, secret: "segredo",
		limit: &loginLimiter{now: clk.now},
		now:   clk.now,
	}
	return a, clk
}

func TestPairTokenWorksOnce(t *testing.T) {
	a, _ := newTestPhone(t)
	tok, _, err := a.pairCreate()
	if err != nil {
		t.Fatal(err)
	}
	if len(tok) < 43 { // 32 bytes em base64 = 256 bits
		t.Fatalf("token curto: %d", len(tok))
	}
	sess, err := a.pairRedeem("1.1.1.1", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1", tok)
	if err != nil || sess == "" {
		t.Fatalf("resgate: %v", err)
	}
	if !a.valid(sess) {
		t.Fatal("sessão não vale")
	}
	if _, err := a.pairRedeem("1.1.1.1", "", tok); err != errPairInvalid {
		t.Fatalf("token já usado: %v", err)
	}
	if got := a.deviceViews(); len(got) != 1 || got[0].Name != "iPhone — Safari" {
		t.Fatalf("aparelhos: %+v", got)
	}
}

func TestPairTokenExpires(t *testing.T) {
	a, clk := newTestPhone(t)
	tok, _, _ := a.pairCreate()
	clk.t = clk.t.Add(pairTTL - time.Second)
	if a.pairPending() != 1 {
		t.Fatal("ainda devia valer")
	}
	clk.t = clk.t.Add(2 * time.Second)
	if _, err := a.pairRedeem("1.1.1.1", "", tok); err != errPairInvalid {
		t.Fatalf("expirado: %v", err)
	}
	if a.pairPending() != 0 {
		t.Fatal("pendente vencido ficou")
	}
}

func TestNewLinkInvalidatesPrevious(t *testing.T) {
	a, _ := newTestPhone(t)
	first, _, _ := a.pairCreate()
	second, _, _ := a.pairCreate()
	if _, err := a.pairRedeem("1.1.1.1", "", first); err != errPairInvalid {
		t.Fatalf("link antigo ainda vale: %v", err)
	}
	if _, err := a.pairRedeem("1.1.1.1", "", second); err != nil {
		t.Fatal(err)
	}
}

func TestPairWrongToken(t *testing.T) {
	a, _ := newTestPhone(t)
	good, _, _ := a.pairCreate()
	for _, bad := range []string{"", "x", good + "x", strings.Repeat("a", 500)} {
		if _, err := a.pairRedeem("1.1.1.1", "", bad); err != errPairInvalid {
			t.Fatalf("%q: %v", bad, err)
		}
	}
	if _, err := a.pairRedeem("9.9.9.9", "", good); err != nil {
		t.Fatalf("o token certo continua valendo: %v", err)
	}
}

func TestPairConcurrentOnlyOneWins(t *testing.T) {
	a, _ := newTestPhone(t)
	a.limit = newLoginLimiter()
	tok, _, _ := a.pairCreate()
	var wins int32
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := a.pairRedeem("2.2.2.2", "", tok); err == nil {
				atomic.AddInt32(&wins, 1)
			}
		}()
	}
	wg.Wait()
	if wins != 1 || len(a.deviceViews()) != 1 {
		t.Fatalf("vitórias=%d aparelhos=%d", wins, len(a.deviceViews()))
	}
}

func TestPairRateLimit(t *testing.T) {
	a, clk := newTestPhone(t)
	for i := 0; i < limitPerIP; i++ {
		if _, err := a.pairRedeem("3.3.3.3", "", "errado"); err != errPairInvalid {
			t.Fatal(err)
		}
	}
	good, _, _ := a.pairCreate()
	if _, err := a.pairRedeem("3.3.3.3", "", good); err == nil || err == errPairInvalid {
		t.Fatalf("devia estar travado: %v", err)
	}
	// outro IP (usuário legítimo) não é afetado
	if _, err := a.pairRedeem("4.4.4.4", "", good); err != nil {
		t.Fatalf("outro IP: %v", err)
	}
	good2, _, _ := a.pairCreate()
	clk.t = clk.t.Add(limitFirstLock + time.Second)
	if _, err := a.pairRedeem("3.3.3.3", "", good2); err != nil {
		t.Fatalf("liberado depois da espera: %v", err)
	}
}

func TestDevicesStoreOnlyHashes(t *testing.T) {
	a, _ := newTestPhone(t)
	pair, _, _ := a.pairCreate()
	sess, _ := a.pairRedeem("1.1.1.1", "", pair)
	pending, _, _ := a.pairCreate()
	b, err := os.ReadFile(filepath.Join(a.dir, phoneDevicesFile))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(b, []byte(sess)) || bytes.Contains(b, []byte(pair)) || bytes.Contains(b, []byte(pending)) {
		t.Fatal("token em claro no disco")
	}
}

func TestDevicesPersistAndReload(t *testing.T) {
	a, clk := newTestPhone(t)
	tok, _, _ := a.pairCreate()
	sess, _ := a.pairRedeem("1.1.1.1", "", tok)
	pending, _, _ := a.pairCreate()
	b := &phoneAuth{dir: a.dir, now: clk.now, limit: a.limit}
	b.loadDevices()
	if !b.valid(sess) {
		t.Fatal("sessão não sobreviveu ao reinício")
	}
	if _, err := b.pairRedeem("5.5.5.5", "", pending); err != nil {
		t.Fatalf("link pendente: %v", err)
	}
}

func TestSessionExpiry(t *testing.T) {
	a, clk := newTestPhone(t)
	tok, _, _ := a.pairCreate()
	sess, _ := a.pairRedeem("1.1.1.1", "", tok)
	// uso mantém viva além dos 90 dias de calendário
	for i := 0; i < 4; i++ {
		clk.t = clk.t.Add(80 * 24 * time.Hour)
		if _, ok := a.session(sess, "1.1.1.1"); !ok {
			t.Fatalf("expirou em uso (volta %d)", i)
		}
	}
	// 400 dias depois da criação: limite absoluto, mesmo com uso
	clk.t = time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC).Add(deviceAbsMax + time.Hour)
	if a.valid(sess) {
		t.Fatal("passou do limite absoluto")
	}
	tok2, _, _ := a.pairCreate()
	s2, _ := a.pairRedeem("1.1.1.1", "", tok2)
	clk.t = clk.t.Add(deviceIdleMax + time.Hour)
	if a.valid(s2) {
		t.Fatal("sem uso por 90 dias devia expirar")
	}
}

func TestSessionRecordsUseAndIP(t *testing.T) {
	a, clk := newTestPhone(t)
	tok, _, _ := a.pairCreate()
	sess, _ := a.pairRedeem("1.1.1.1", "", tok)
	clk.t = clk.t.Add(time.Hour)
	a.session(sess, "8.8.8.8")
	d := a.deviceViews()[0]
	if d.LastIP != "8.8.8.8" || !d.LastUsed.Equal(clk.t) {
		t.Fatalf("%+v", d)
	}
}

func TestRevokeDropsSessionAndWebsocket(t *testing.T) {
	a, _ := newTestPhone(t)
	h := newHub(false)
	a.onDrop = h.dropPhone
	t1, _, _ := a.pairCreate()
	s1, _ := a.pairRedeem("1.1.1.1", "", t1)
	t2, _, _ := a.pairCreate()
	s2, _ := a.pairRedeem("1.1.1.2", "", t2)
	id1, _ := a.session(s1, "")
	id2, _ := a.session(s2, "")
	c1, c2 := h.add(), h.add()
	c1.device, c2.device = id1, id2
	if !a.revokeDevice(id1) {
		t.Fatal("revogar")
	}
	if a.valid(s1) {
		t.Fatal("sessão revogada ainda vale")
	}
	select {
	case <-c1.gone:
	default:
		t.Fatal("WebSocket do aparelho revogado continua aberto")
	}
	select {
	case <-c2.gone:
		t.Fatal("derrubou o aparelho errado")
	default:
	}
	if !a.valid(s2) {
		t.Fatal("o outro aparelho caiu")
	}
}

func TestRevokeAll(t *testing.T) {
	a, _ := newTestPhone(t)
	h := newHub(false)
	a.onDrop = h.dropPhone
	var ids []string
	var toks []string
	for i := 0; i < 3; i++ {
		p, _, _ := a.pairCreate()
		s, _ := a.pairRedeem("1.1.1.1", "", p)
		id, _ := a.session(s, "")
		toks, ids = append(toks, s), append(ids, id)
	}
	cs := []*client{h.add(), h.add(), h.add()}
	for i, c := range cs {
		c.device = ids[i]
	}
	if n := a.revokeAllDevices(); n != 3 {
		t.Fatalf("n=%d", n)
	}
	for i, c := range cs {
		if a.valid(toks[i]) {
			t.Fatal("sessão viva")
		}
		select {
		case <-c.gone:
		default:
			t.Fatal("WS vivo")
		}
	}
}

func TestRenameDevice(t *testing.T) {
	a, _ := newTestPhone(t)
	p, _, _ := a.pairCreate()
	s, _ := a.pairRedeem("1.1.1.1", "", p)
	id, _ := a.session(s, "")
	if err := a.renameDevice(id, "  Celular\tda   Ana\n"); err != nil {
		t.Fatal(err)
	}
	if got := a.deviceViews()[0].Name; got != "Celular da Ana" {
		t.Fatalf("%q", got)
	}
	if a.renameDevice(id, "   ") == nil {
		t.Fatal("nome vazio")
	}
	if a.renameDevice("nao-existe", "x") == nil {
		t.Fatal("id inexistente")
	}
	if err := a.renameDevice(id, strings.Repeat("é", 100)); err != nil || len([]rune(a.deviceViews()[0].Name)) != deviceNameMax {
		t.Fatalf("nome longo: %v", err)
	}
}

func TestDeviceNameFromUA(t *testing.T) {
	cases := map[string]string{
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Version/17.0 Mobile Safari/604.1": "iPhone — Safari",
		"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit Chrome/120.0 Mobile Safari/537.36":              "Android — Chrome",
		"Mozilla/5.0 (Linux; Android 14) AppleWebKit Chrome/120 Mobile Safari/537.36 EdgA/120":                 "Android — Edge",
		"Mozilla/5.0 (Android 14; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0":                                 "Android — Firefox",
		"": "Celular",
	}
	for ua, want := range cases {
		if got := deviceNameFromUA(ua); got != want {
			t.Errorf("%q: %q != %q", ua, got, want)
		}
	}
}

func TestPasswordLoginCreatesDeviceAndOldPasswordKeepsWorking(t *testing.T) {
	a, _ := newTestPhone(t)
	hash, _ := bcrypt.GenerateFromPassword([]byte("senha-antiga"), bcrypt.MinCost)
	a.hash = hash
	sess, err := a.login("1.1.1.1", "Mozilla/5.0 (Windows NT 10.0) Chrome/120", "senha-antiga")
	if err != nil {
		t.Fatal(err)
	}
	if got := a.deviceViews(); len(got) != 1 || got[0].Name != "Windows — Chrome" {
		t.Fatalf("%+v", got)
	}
	// Trocar a senha NÃO revoga o aparelho pareado.
	old := secrets
	secrets = &secretStore{}
	secrets.load(t.TempDir())
	t.Cleanup(func() { secrets = old })
	if err := a.setPassword("outra-senha-9"); err != nil {
		t.Skipf("cofre indisponível neste ambiente: %v", err)
	}
	if !a.valid(sess) {
		t.Fatal("trocar a senha derrubou o aparelho")
	}
	if _, err := a.login("1.1.1.1", "", "outra-senha-9"); err != nil {
		t.Fatal(err)
	}
}

func TestMigrateLegacySessions(t *testing.T) {
	a, clk := newTestPhone(t)
	legacy := filepath.Join(a.dir, phoneLegacyFile)
	body, _ := json.Marshal(map[string]any{"tokens": map[string]time.Time{
		"token-antigo-vivo":    clk.t.Add(time.Hour),
		"token-antigo-vencido": clk.t.Add(-time.Hour),
	}})
	if err := os.WriteFile(legacy, body, 0o644); err != nil {
		t.Fatal(err)
	}
	a.loadDevices()
	if !a.valid("token-antigo-vivo") {
		t.Fatal("sessão antiga não migrou")
	}
	if a.valid("token-antigo-vencido") {
		t.Fatal("migrou sessão vencida")
	}
	if _, err := os.Stat(legacy); err == nil {
		t.Fatal("arquivo antigo (tokens em claro) ficou")
	}
	b, _ := os.ReadFile(filepath.Join(a.dir, phoneDevicesFile))
	if bytes.Contains(b, []byte("token-antigo-vivo")) {
		t.Fatal("token em claro no arquivo novo")
	}
}

// ---- rotas ----

func newGateServer(t *testing.T) (*server, *phoneAuth) {
	t.Helper()
	a, _ := newTestPhone(t)
	hash, _ := bcrypt.GenerateFromPassword([]byte("senha-certa"), bcrypt.MinCost)
	a.hash = hash
	a.limit = newLoginLimiter()
	old := phone
	phone = a
	t.Cleanup(func() { phone = old })
	return &server{hub: newHub(false)}, a
}

func postJSON(srv *server, path, body, cookie string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	r.Header.Set("Origin", "https://"+testDomain)
	r.Header.Set("User-Agent", "Mozilla/5.0 (iPhone) Safari/604.1")
	r.Header.Set("X-BethStudio-Client", "7.7.7.7")
	if cookie != "" {
		r.AddCookie(&http.Cookie{Name: phoneCookie, Value: cookie})
	}
	rec := httptest.NewRecorder()
	srv.servePhonePublic(rec, r)
	return rec
}

func TestPairEndpointSetsCookie(t *testing.T) {
	srv, a := newGateServer(t)
	tok, _, _ := a.pairCreate()
	rec := postJSON(srv, "/api/phone/pair", `{"token":"`+tok+`"}`, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	var ck *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == phoneCookie {
			ck = c
		}
	}
	if ck == nil || !ck.HttpOnly || !ck.Secure || ck.SameSite != http.SameSiteStrictMode || ck.MaxAge != 90*24*3600 {
		t.Fatalf("cookie: %+v", ck)
	}
	// o cookie abre /api/phone/me
	rec = httptest.NewRecorder()
	srv.servePhonePublic(rec, phoneReq(http.MethodGet, "/api/phone/me", ck.Value))
	if rec.Code != http.StatusOK {
		t.Fatalf("me: %d", rec.Code)
	}
	// segundo uso do mesmo link: recusado
	rec = postJSON(srv, "/api/phone/pair", `{"token":"`+tok+`"}`, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("reuso: %d", rec.Code)
	}
}

// As rotas de gestão não existem para o celular, mesmo logado.
func TestManagementRoutesNotReachableFromPhone(t *testing.T) {
	srv, a := newGateServer(t)
	p, _, _ := a.pairCreate()
	sess, _ := a.pairRedeem("1.1.1.1", "", p)
	for _, path := range []string{"/api/phone/devices", "/api/phone/devices/pairing", "/api/phone/devices/pairing/cancel",
		"/api/phone/devices/rename", "/api/phone/devices/revoke", "/api/phone/devices/revoke-all"} {
		for _, m := range []string{http.MethodGet, http.MethodPost} {
			r := phoneReq(m, path, sess)
			rec := httptest.NewRecorder()
			srv.servePhonePublic(rec, r)
			if rec.Code != http.StatusNotFound {
				t.Fatalf("%s %s: %d", m, path, rec.Code)
			}
		}
	}
	if len(a.deviceViews()) != 1 {
		t.Fatal("o celular mexeu nos aparelhos")
	}
}

func TestManagementRoutesBlockedForRemoteStudio(t *testing.T) {
	for _, p := range []string{"/api/phone/devices", "/api/phone/devices/pairing", "/api/phone/devices/rename",
		"/api/phone/devices/revoke", "/api/phone/devices/revoke-all", "/api/phone/devices/pairing/cancel"} {
		if !remoteBlocked(p, http.MethodGet) || !remoteBlocked(p, http.MethodPost) {
			t.Fatalf("%s alcançável pelo Studio remoto", p)
		}
	}
	srv, _ := newGateServer(t)
	rec := httptest.NewRecorder()
	srv.servePhoneDevices(rec, httptest.NewRequest(http.MethodGet, "/api/phone/devices", nil), "chave-remota")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("%d", rec.Code)
	}
}

func TestManagementAPIFlow(t *testing.T) {
	srv, a := newGateServer(t)
	call := func(method, path, body string) (*httptest.ResponseRecorder, map[string]any) {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		rec := httptest.NewRecorder()
		srv.servePhoneDevices(rec, r, "")
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec, out
	}
	rec, out := call(http.MethodPost, "/api/phone/devices/pairing", "{}")
	if rec.Code != 200 {
		t.Fatalf("pairing %d %s", rec.Code, rec.Body.String())
	}
	link, _ := out["link"].(string)
	if !strings.HasPrefix(link, "https://"+testDomain+"/#pair=") || !strings.HasPrefix(out["qr"].(string), "data:image/png;base64,") {
		t.Fatalf("%v", out)
	}
	if strings.Contains(link, "?") {
		t.Fatal("token em query string")
	}
	tok := strings.TrimPrefix(link, "https://"+testDomain+"/#pair=")
	sess, err := a.pairRedeem("1.1.1.1", "", tok)
	if err != nil {
		t.Fatal(err)
	}
	_, out = call(http.MethodGet, "/api/phone/devices", "")
	devs := out["devices"].([]any)
	if len(devs) != 1 || out["pending"].(float64) != 0 {
		t.Fatalf("%v", out)
	}
	id := devs[0].(map[string]any)["id"].(string)
	if _, bad := devs[0].(map[string]any)["hash"]; bad {
		t.Fatal("hash vazou na API")
	}
	if rec, _ := call(http.MethodPost, "/api/phone/devices/rename", `{"id":"`+id+`","name":"iPhone da Ana"}`); rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	if rec, _ := call(http.MethodPost, "/api/phone/devices/revoke", `{"id":"`+id+`"}`); rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	if a.valid(sess) {
		t.Fatal("revogado ainda vale")
	}
	if rec, _ := call(http.MethodPost, "/api/phone/devices/revoke", `{"id":""}`); rec.Code != http.StatusNotFound {
		t.Fatalf("revogar sem id: %d", rec.Code)
	}
	if rec, _ := call(http.MethodGet, "/api/phone/devices/revoke-all", ""); rec.Code != http.StatusMethodNotAllowed {
		t.Fatal("revoke-all por GET")
	}
}

func TestNoSecretsInLog(t *testing.T) {
	dir := t.TempDir()
	oldDir := remoteLogDir
	remoteLogDir = dir
	t.Cleanup(func() { remoteLogDir = oldDir })
	srv, a := newGateServer(t)
	tok, _, _ := a.pairCreate()
	postJSON(srv, "/api/phone/pair", `{"token":"token-errado-secreto"}`, "")
	postJSON(srv, "/api/phone/login", `{"password":"senha-errada-secreta"}`, "")
	rec := postJSON(srv, "/api/phone/pair", `{"token":"`+tok+`"}`, "")
	postJSON(srv, "/api/phone/login", `{"password":"senha-certa"}`, "")
	var sess string
	for _, c := range rec.Result().Cookies() {
		sess = c.Value
	}
	b, err := os.ReadFile(filepath.Join(dir, "remote-access.log"))
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"token-errado-secreto", "senha-errada-secreta", "senha-certa", tok, sess} {
		if sess == "" || strings.Contains(string(b), secret) {
			t.Fatalf("segredo %q no log:\n%s", secret, b)
		}
	}
	if !strings.Contains(string(b), "7.7.7.7") {
		t.Fatalf("log sem IP:\n%s", b)
	}
}

// O IP do limitador vem do cabeçalho do proxy; trocar de IP no cabeçalho do
// cliente não chega aqui porque o proxy sobrescreve (ver phonelink).
func TestLoginRateLimitPerIPOnGate(t *testing.T) {
	srv, _ := newGateServer(t)
	for i := 0; i < limitPerIP; i++ {
		if rec := postJSON(srv, "/api/phone/login", `{"password":"errada"}`, ""); rec.Code != http.StatusUnauthorized {
			t.Fatal(rec.Code)
		}
	}
	rec := postJSON(srv, "/api/phone/login", `{"password":"senha-certa"}`, "")
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "muitas tentativas") {
		t.Fatalf("devia travar: %d %s", rec.Code, rec.Body.String())
	}
}
