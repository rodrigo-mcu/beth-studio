package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"html/template"
	"image/png"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/boombuler/barcode"
	"github.com/boombuler/barcode/qr"
)

// Porta do Studio remoto no túnel: https://<domínio>/studio/...
// O app do celular continua em "/". Ver remote_auth.go.

// Só no PC: configurar o acesso e o que abre algo na tela do PC.
var remoteOnlyOnPC = map[string]bool{
	"/api/phone/setup":             true,
	"/api/phone/devices":                 true,
	"/api/phone/devices/pairing":         true,
	"/api/phone/devices/pairing/cancel":  true,
	"/api/phone/devices/rename":          true,
	"/api/phone/devices/revoke":          true,
	"/api/phone/devices/revoke-all":      true,
	"/api/remote":                  true,
	"/api/remote/totp":             true,
	"/api/remote/revoke":           true,
	"/api/pick-folder":             true,
	"/api/local-file/open-dialog":  true,
	"/api/local-file/save-as":      true,
	"/api/local-file/reveal":       true,
	"/api/local-file/open-default": true,
	"/api/local-fs/reveal":         true,
	"/api/open-link":               true,
	"/api/ai-usage/open":           true,
	"/api/voice/open-keys":         true,
	"/api/voice/open-pricing":      true,
	"/api/pane/scrollback/save":    true,
	"/api/pane/screenshot/save":    true,
	"/api/db/window":               true,
	"/api/ssh/sftp/window":         true,
	"/api/ssh/sftp/reveal":         true,
}

func remoteBlocked(sub, method string) bool {
	if remoteOnlyOnPC[sub] {
		return true
	}
	// Assistente de instalação do servidor (VPS): credenciais de root e da Cloudflare, só no PC.
	if strings.HasPrefix(sub, "/api/vps/") {
		return true
	}
	// GET /api/about lista os arquivos; POST abre o Explorer no PC.
	if sub == "/api/about" && method != http.MethodGet && method != http.MethodHead {
		return true
	}
	// Consultar release pelo navegador remoto pode; instalar, não.
	return strings.HasPrefix(sub, "/api/update/") && method != http.MethodGet && method != http.MethodHead
}

func remoteHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("Referrer-Policy", "same-origin") // ver servePhonePublic
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Permissions-Policy", "microphone=(self), camera=(), geolocation=()")
	h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
}

// remoteOriginOK: pedidos que mudam algo e o WebSocket só valem vindos da
// própria página (https://<domínio>).
func remoteOriginOK(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return false
	}
	u, err := url.Parse(o)
	if err != nil || u.Scheme != "https" {
		return false
	}
	domain, _ := phone.creds()
	return domain != "" && strings.EqualFold(u.Host, domain)
}

func setRemoteCookie(w http.ResponseWriter, token string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name: remoteCookie, Value: token, Path: remoteBase,
		HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode, MaxAge: maxAge,
	})
}

func (s *server) serveRemote(w http.ResponseWriter, r *http.Request) {
	remoteHeaders(w)
	sub := strings.TrimPrefix(r.URL.Path, remoteBase)
	if sub == "" {
		http.Redirect(w, r, remoteBase+"/", http.StatusFound)
		return
	}
	if !remote.active() {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		_ = remotePage.Execute(w, remotePageData{Off: true})
		return
	}
	isGet := r.Method == http.MethodGet || r.Method == http.MethodHead
	if !isGet && !remoteOriginOK(r) {
		http.Error(w, "origem inválida", http.StatusForbidden)
		return
	}
	switch sub {
	case "/login":
		s.serveRemoteLogin(w, r)
		return
	case "/logout":
		if r.Method != http.MethodPost {
			http.Error(w, "use POST", http.StatusMethodNotAllowed)
			return
		}
		if key, ok := remote.session(r); ok {
			remote.logout(key)
		}
		setRemoteCookie(w, "", -1)
		http.Redirect(w, r, remoteBase+"/login", http.StatusSeeOther)
		return
	}
	key, ok := remote.session(r)
	if !ok {
		if strings.HasPrefix(sub, "/api/") || sub == "/ws" {
			http.Error(w, "login", http.StatusUnauthorized)
			return
		}
		http.Redirect(w, r, remoteBase+"/login", http.StatusFound)
		return
	}
	if sub == "/ws" && !remoteOriginOK(r) {
		http.Error(w, "origem inválida", http.StatusForbidden)
		return
	}
	if remoteBlocked(sub, r.Method) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Disponível só no PC"})
		return
	}
	r2 := r.Clone(r.Context())
	r2.URL.Path = sub
	r2.URL.RawPath = ""
	r2.RequestURI = ""
	s.route(w, r2, key)
}

func (s *server) serveRemoteLogin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		if _, ok := remote.session(r); ok {
			http.Redirect(w, r, remoteBase+"/", http.StatusFound)
			return
		}
		_ = remotePage.Execute(w, remotePageData{})
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if err := r.ParseForm(); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = remotePage.Execute(w, remotePageData{Err: "pedido inválido"})
		return
	}
	token, err := remote.login(phoneClientIP(r), r.UserAgent(), r.PostForm.Get("password"), r.PostForm.Get("code"))
	if err != nil {
		w.WriteHeader(http.StatusUnauthorized)
		_ = remotePage.Execute(w, remotePageData{Err: err.Error()})
		return
	}
	setRemoteCookie(w, token, int(remoteMaxAge/time.Second))
	http.Redirect(w, r, remoteBase+"/", http.StatusSeeOther)
}

type remotePageData struct {
	Off bool
	Err string
}

// Página de login sem JavaScript: só um formulário.
var remotePage = template.Must(template.New("login").Parse(`<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Beth Studio</title>
<style>
:root{color-scheme:light dark;--bg:#eef2f9;--card:#fff;--ink:#13203a;--muted:#56657f;--line:#d3dbea;--brand:#1668cf;--err:#c02a27}
@media (prefers-color-scheme:dark){:root{--bg:#14203a;--card:#1c2b4b;--ink:#e8eef9;--muted:#93a3c2;--line:#2c3f66;--brand:#2f8cf0;--err:#ff7b7f}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px}
main{width:100%;max-width:360px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px 24px}
h1{margin:0 0 4px;font-size:22px}
p{margin:0 0 20px;color:var(--muted);font-size:14px}
label{display:block;font-size:14px;font-weight:600;margin:14px 0 6px}
input{width:100%;font:inherit;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
input:focus{outline:2px solid var(--brand);outline-offset:1px}
button{width:100%;margin-top:22px;padding:12px;border:0;border-radius:10px;background:var(--brand);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{color:var(--err);margin:14px 0 0;font-size:14px}
</style></head><body><main>
<h1>Beth Studio</h1>
{{if .Off}}<p>O Studio pelo navegador está desligado neste computador.</p>
{{else}}<p>Entre com a senha do celular e o código do app autenticador.</p>
<form method="post" action="login" autocomplete="on">
<label for="pw">Senha</label>
<input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
<label for="code">Código</label>
<input id="code" name="code" inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7" autocomplete="one-time-code" required>
{{if .Err}}<p class="err" role="alert">{{.Err}}</p>{{end}}
<button type="submit">Entrar</button>
</form>{{end}}
</main></body></html>`))

// --- administração (só no Studio do PC) ----------------------------------

type remoteAdminView struct {
	Enabled   bool                `json:"enabled"`
	HasTOTP   bool                `json:"has_totp"`
	URL       string              `json:"url"`
	Sessions  []remoteSessionView `json:"sessions"`
	Connected int                 `json:"connected"`
	// só durante a configuração do segundo fator
	Secret string `json:"secret,omitempty"`
	QR     string `json:"qr,omitempty"` // data:image/png;base64
}

func (s *server) remoteAdminView() remoteAdminView {
	en, has, list := remote.view()
	if list == nil {
		list = []remoteSessionView{}
	}
	v := remoteAdminView{Enabled: en, HasTOTP: has, Sessions: list, Connected: s.hub.remoteCount()}
	if domain, ok := phone.configured(); ok {
		v.URL = "https://" + domain + remoteBase + "/"
	}
	return v
}

func totpQR(uri string) (string, error) {
	code, err := qr.Encode(uri, qr.M, qr.Auto)
	if err != nil {
		return "", err
	}
	code, err = barcode.Scale(code, 240, 240)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, code); err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}

// serveRemoteAdmin: GET /api/remote (estado), POST /api/remote {enabled},
// POST /api/remote/totp {action: start|confirm, code}, POST /api/remote/revoke {id|""}.
func (s *server) serveRemoteAdmin(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api/remote" && r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, s.remoteAdminView())
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Enabled *bool  `json:"enabled"`
		Action  string `json:"action"`
		Code    string `json:"code"`
		ID      string `json:"id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
		return
	}
	fail := func(err error) { writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()}) }
	switch r.URL.Path {
	case "/api/remote":
		if req.Enabled == nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "falta enabled"})
			return
		}
		if err := remote.setEnabled(*req.Enabled); err != nil {
			fail(err)
			return
		}
		writeJSON(w, http.StatusOK, s.remoteAdminView())
	case "/api/remote/totp":
		switch req.Action {
		case "start":
			sec, err := remote.startTOTP()
			if err != nil {
				fail(err)
				return
			}
			domain, _ := phone.creds()
			account := domain
			if account == "" {
				account = "este PC"
			}
			img, err := totpQR(totpURI(sec, account))
			if err != nil {
				fail(err)
				return
			}
			v := s.remoteAdminView()
			v.Secret = sec
			v.QR = img
			writeJSON(w, http.StatusOK, v)
		case "confirm":
			if err := remote.confirmTOTP(req.Code); err != nil {
				fail(err)
				return
			}
			writeJSON(w, http.StatusOK, s.remoteAdminView())
		default:
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "ação desconhecida"})
		}
	case "/api/remote/revoke":
		remote.revoke(strings.TrimSpace(req.ID), "encerrada no PC")
		writeJSON(w, http.StatusOK, s.remoteAdminView())
	}
}
