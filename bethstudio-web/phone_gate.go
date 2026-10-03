package main

import (
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"strconv"
	"strings"

	"bethstudio-web/phonelink"
	"bethstudio-web/webui"
)

func phoneOpAllowed(op string) bool {
	switch op {
	case "list", "watch", "scroll", "send", "paste":
		return true
	default:
		return false
	}
}

// phoneVoiceView é o que o celular pode ver. Sem endereço de provedor e sem chave:
// o áudio sobe para este PC, e a transcrição acontece aqui.
func phoneVoiceView() map[string]any {
	v := settings.voice()
	prefix := true
	if v.PrefixEnabled != nil {
		prefix = *v.PrefixEnabled
	}
	return map[string]any{
		"settings": map[string]any{
			"privacy_ack":         v.PrivacyAck,
			"llm_enabled":         v.LLMEnabled,
			"prefix_enabled":      prefix,
			"prefix_text":         v.PrefixText,
			"correct_timeout_sec": v.CorrectTimeoutSec,
		},
	}
}

// phoneStatic: o app do celular (frontend/dist/phone, build própria). É
// público porque não tem dado nenhum: os terminais e a voz só vêm por /api e
// /ws, que pedem a senha. Nada do Studio do PC é servido neste domínio.
var phoneStatic = func() http.Handler {
	sub, err := fs.Sub(webui.Dist, "dist/phone")
	if err != nil {
		panic(err)
	}
	return http.FileServer(http.FS(sub))
}()

func phonePublicFile(p string) bool {
	switch p {
	case "/", "/index.html", "/manifest.webmanifest", "/sw.js":
		return true
	}
	return strings.HasPrefix(p, "/assets/") || strings.HasPrefix(p, "/icons/")
}

func servePhoneStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		return
	}
	h := w.Header()
	switch {
	case strings.HasPrefix(r.URL.Path, "/assets/"):
		// nome com hash: nunca muda
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	case strings.HasPrefix(r.URL.Path, "/icons/"):
		h.Set("Cache-Control", "public, max-age=86400")
	default:
		h.Set("Cache-Control", "no-cache")
	}
	if r.URL.Path == "/manifest.webmanifest" {
		h.Set("Content-Type", "application/manifest+json")
	}
	if r.URL.Path == "/index.html" {
		http.Redirect(w, r, "/", http.StatusMovedPermanently)
		return
	}
	phoneStatic.ServeHTTP(w, r)
}

func (s *server) servePhonePublic(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == remoteBase || strings.HasPrefix(r.URL.Path, remoteBase+"/") {
		s.serveRemote(w, r)
		return
	}
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	// same-origin: com no-referrer o navegador manda "Origin: null" nos POSTs
	// da própria página, e a checagem de origem recusaria tudo.
	h.Set("Referrer-Policy", "same-origin")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Permissions-Policy", "microphone=(self), camera=(), geolocation=()")
	h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")

	// Pedido que muda algo, ou o WebSocket, só da própria página.
	if (r.Method != http.MethodGet && r.Method != http.MethodHead) || r.URL.Path == "/ws" {
		if !remoteOriginOK(r) {
			http.Error(w, "origem inválida", http.StatusForbidden)
			return
		}
	}
	if r.URL.Path == "/api/phone/login" && r.Method == http.MethodPost {
		s.servePhoneLogin(w, r)
		return
	}
	if r.URL.Path == "/api/phone/logout" && r.Method == http.MethodPost {
		if c, err := r.Cookie(phoneCookie); err == nil {
			phone.logout(c.Value)
		}
		setPhoneCookie(w, "", -1)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	if phonePublicFile(r.URL.Path) {
		servePhoneStatic(w, r)
		return
	}
	if !phone.authorized(r) {
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/ws" {
			http.Error(w, "login", http.StatusUnauthorized)
			return
		}
		http.NotFound(w, r)
		return
	}
	s.servePhoneAuthed(w, r)
}

func (s *server) servePhoneLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
		return
	}
	token, err := phone.login(phoneClientIP(r), req.Password)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	setPhoneCookie(w, token, 30*24*3600)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) servePhoneAuthed(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/ws":
		s.serveWS(w, r, true)
	case r.URL.Path == "/api/phone/me":
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case r.URL.Path == "/api/phone/names":
		// Nomes que a pessoa deu às abas no Studio (pane id -> nome).
		names := settings.snapshot().PaneNames
		if names == nil {
			names = map[string]string{}
		}
		writeJSON(w, http.StatusOK, names)
	case r.URL.Path == "/api/phone/image":
		s.servePhoneImage(w, r)
	case strings.HasPrefix(r.URL.Path, "/api/voice"):
		s.servePhoneVoice(w, r)
	default:
		http.NotFound(w, r)
	}
}

// servePhoneImage guarda a imagem neste PC (como colar imagem no Studio) e
// devolve o link, sem colar: o celular põe o link no rascunho e só o Enviar
// manda para o terminal.
func (s *server) servePhoneImage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		return
	}
	if s.hub.readOnly {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "modo somente leitura"})
		return
	}
	pane, err := strconv.Atoi(r.URL.Query().Get("pane_id"))
	if err != nil || pane < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "pane_id inválido"})
		return
	}
	ctype := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]))
	if !allowedImageTypes[ctype] {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "tipo de imagem não aceito: " + ctype})
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxPasteBytes))
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "imagem grande demais (máx. 25 MB)"})
		return
	}
	if len(data) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "imagem vazia"})
		return
	}
	path, _, _, err := savePastedImage(data)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": path, "text": markdownImageLink(path, s.hub.paneLooksWSL(pane))})
}

func (s *server) servePhoneVoice(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/voice":
		if r.Method != http.MethodGet {
			http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, http.StatusOK, phoneVoiceView())
	case "/api/voice/transcribe":
		if r.Method != http.MethodPost {
			http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
			return
		}
		s.serveTranscribe(w, r)
	case "/api/voice/correct":
		if r.Method != http.MethodPost {
			http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
			return
		}
		s.serveVoice(w, r)
	case "/api/voice/settings":
		s.servePhonePrivacy(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (s *server) servePhonePrivacy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		PrivacyAck bool `json:"privacy_ack"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
		return
	}
	v := settings.voice()
	v.PrivacyAck = req.PrivacyAck
	if err := settings.setVoice(v); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, phoneVoiceView())
}

func (s *server) servePhoneSetup(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, phoneSetupView())
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Code     string `json:"code"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
		return
	}
	code, err := phonelink.ParseCode(req.Code)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	pw := strings.TrimSpace(req.Password)
	if pw != "" {
		if err := phone.setPassword(pw); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	} else if _, ok := phone.configured(); !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "crie a senha do celular"})
		return
	}
	if err := phone.setLink(code.Domain, code.Secret); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	phoneLink.set("connecting", "")
	kickPhoneLink()
	writeJSON(w, http.StatusOK, phoneSetupView())
}

func phoneSetupView() map[string]any {
	domain, ok := phone.configured()
	link, detail := phoneLinkView()
	return map[string]any{"domain": domain, "configured": ok, "link": link, "detail": detail}
}
