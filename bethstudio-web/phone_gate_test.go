package main

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func withPhoneSession(t *testing.T) string {
	t.Helper()
	old := phone
	phone = &phoneAuth{
		domain:   testDomain,
		secret:   "segredo",
		now:      time.Now,
	}
	t.Cleanup(func() { phone = old })
	phone.mu.Lock()
	tok, _ := phone.addDeviceLocked("1.1.1.1", "")
	phone.mu.Unlock()
	return tok
}

const testDomain = "agentes.exemplo.com"

func phoneReq(method, path, cookie string) *http.Request {
	r := httptest.NewRequest(method, path, nil)
	r.Header.Set("Origin", "https://"+testDomain)
	if cookie != "" {
		r.AddCookie(&http.Cookie{Name: phoneCookie, Value: cookie})
	}
	return r
}

func TestPhoneGateNeedsLoginForData(t *testing.T) {
	withPhoneSession(t)
	srv := &server{hub: newHub(false)}
	for _, p := range []string{"/api/phone/me", "/api/voice", "/ws", "/api/settings"} {
		rec := httptest.NewRecorder()
		srv.servePhonePublic(rec, phoneReq(http.MethodGet, p, ""))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s sem senha: %d", p, rec.Code)
		}
	}
}

func TestPhoneGateMe(t *testing.T) {
	tok := withPhoneSession(t)
	srv := &server{hub: newHub(false)}
	rec := httptest.NewRecorder()
	srv.servePhonePublic(rec, phoneReq(http.MethodGet, "/api/phone/me", tok))
	if rec.Code != http.StatusOK {
		t.Fatalf("me: %d %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Referrer-Policy"); got != "same-origin" {
		t.Fatalf("Referrer-Policy %q: com no-referrer o POST da página chega com Origin: null", got)
	}
	if got := rec.Header().Get("Permissions-Policy"); !strings.Contains(got, "microphone=(self)") {
		t.Fatalf("microfone não liberado: %q", got)
	}
}

// O domínio do celular não serve nada do Studio do PC, mesmo com senha.
func TestPhoneGateNoDesktopRoutes(t *testing.T) {
	tok := withPhoneSession(t)
	srv := &server{hub: newHub(false)}
	for _, p := range []string{"/api/settings", "/api/ssh/hosts", "/api/local-file", "/api/voice/key", "/api/update/check", "/favicon.ico", "/bethstudio-32.png"} {
		rec := httptest.NewRecorder()
		srv.servePhonePublic(rec, phoneReq(http.MethodGet, p, tok))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s: %d", p, rec.Code)
		}
	}
}

func TestPhonePublicFiles(t *testing.T) {
	for _, p := range []string{"/", "/manifest.webmanifest", "/sw.js", "/assets/phone-x.js", "/icons/icon-192.png"} {
		if !phonePublicFile(p) {
			t.Fatalf("%s devia ser público", p)
		}
	}
	for _, p := range []string{"/api/voice", "/ws", "/phone/", "/favicon.ico"} {
		if phonePublicFile(p) {
			t.Fatalf("%s não devia ser público", p)
		}
	}
}

func TestPhoneVoiceHasNoPCMic(t *testing.T) {
	var b strings.Builder
	for k := range phoneVoiceView()["settings"].(map[string]any) {
		b.WriteString(k + " ")
	}
	if strings.Contains(b.String(), "mic_") {
		t.Fatalf("o microfone do PC não vale no celular: %s", b.String())
	}
}

// A imagem do celular fica no PC e volta como link, sem colar no terminal.
func TestPhoneImageSavesWithoutPasting(t *testing.T) {
	tok := withPhoneSession(t)
	dir := t.TempDir()
	oldDir := imageDir
	imageDir = func() string { return dir }
	t.Cleanup(func() { imageDir = oldDir })

	img := image.NewRGBA(image.Rect(0, 0, 4, 3))
	var pn bytes.Buffer
	if err := png.Encode(&pn, img); err != nil {
		t.Fatal(err)
	}
	srv := &server{hub: newHub(false)}
	req := httptest.NewRequest(http.MethodPost, "/api/phone/image?pane_id=3", bytes.NewReader(pn.Bytes()))
	req.Header.Set("Content-Type", "image/png")
	req.Header.Set("Origin", "https://"+testDomain)
	req.AddCookie(&http.Cookie{Name: phoneCookie, Value: tok})
	rec := httptest.NewRecorder()
	srv.servePhonePublic(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	var out struct{ Path, Text string }
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(out.Text, "![image](") || !strings.HasPrefix(out.Path, dir) {
		t.Fatalf("%+v", out)
	}

	// sem senha: não guarda nada
	req = httptest.NewRequest(http.MethodPost, "/api/phone/image?pane_id=3", bytes.NewReader(pn.Bytes()))
	req.Header.Set("Content-Type", "image/png")
	req.Header.Set("Origin", "https://"+testDomain)
	rec = httptest.NewRecorder()
	srv.servePhonePublic(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("sem senha: %d", rec.Code)
	}
}

func TestPhoneNamesNeedsLogin(t *testing.T) {
	tok := withPhoneSession(t)
	srv := &server{hub: newHub(false)}
	rec := httptest.NewRecorder()
	srv.servePhonePublic(rec, phoneReq(http.MethodGet, "/api/phone/names", ""))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("sem senha: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	srv.servePhonePublic(rec, phoneReq(http.MethodGet, "/api/phone/names", tok))
	var names map[string]string
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &names) != nil {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

// Pedido que muda algo, ou o WebSocket, vindo de outro site: recusado.
func TestPhoneGateOrigin(t *testing.T) {
	tok := withPhoneSession(t)
	srv := &server{hub: newHub(false)}
	for _, o := range []string{"", "https://outro.site", "http://" + testDomain} {
		for _, p := range []string{"/ws", "/api/phone/logout", "/api/phone/login"} {
			method := http.MethodPost
			if p == "/ws" {
				method = http.MethodGet
			}
			r := phoneReq(method, p, tok)
			if o == "" {
				r.Header.Del("Origin")
			} else {
				r.Header.Set("Origin", o)
			}
			rec := httptest.NewRecorder()
			srv.servePhonePublic(rec, r)
			if rec.Code != http.StatusForbidden {
				t.Fatalf("%s origem %q: %d", p, o, rec.Code)
			}
		}
	}
}

func TestPhoneGridEndpointsNeedLogin(t *testing.T) {
	tok := withPhoneSession(t)
	srv := &server{hub: newHub(false)}
	for _, c := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/phone/layout", ""},
		{http.MethodPost, "/api/phone/content", `{"pane_ids":[]}`},
	} {
		mk := func(cookie bool) *http.Request {
			r := httptest.NewRequest(c.method, c.path, strings.NewReader(c.body))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Origin", "https://"+testDomain)
			if cookie {
				r.AddCookie(&http.Cookie{Name: phoneCookie, Value: tok})
			}
			return r
		}
		rec := httptest.NewRecorder()
		srv.servePhonePublic(rec, mk(false))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s sem senha: %d", c.path, rec.Code)
		}
		rec = httptest.NewRecorder()
		srv.servePhonePublic(rec, mk(true))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s com senha: %d %s", c.path, rec.Code, rec.Body.String())
		}
	}
}
