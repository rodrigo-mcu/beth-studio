package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// Gestão dos aparelhos: só a interface local do Studio (token do Studio).
// Estas rotas NÃO existem em servePhonePublic (o celular recebe 404) e estão
// em remoteOnlyOnPC (o Studio remoto também não chega aqui).
func phoneDevicesPath(p string) bool {
	switch p {
	case "/api/phone/devices", "/api/phone/devices/pairing", "/api/phone/devices/pairing/cancel",
		"/api/phone/devices/rename", "/api/phone/devices/revoke", "/api/phone/devices/revoke-all":
		return true
	}
	return false
}

func phoneDevicesView() map[string]any {
	domain, ok := phone.configured()
	return map[string]any{
		"devices":    phone.deviceViews(),
		"pending":    phone.pairPending(),
		"configured": ok,
		"domain":     domain,
	}
}

func (s *server) servePhoneDevices(w http.ResponseWriter, r *http.Request, remoteKey string) {
	if remoteKey != "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "só no computador"})
		return
	}
	if r.URL.Path == "/api/phone/devices" {
		if r.Method != http.MethodGet {
			http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, http.StatusOK, phoneDevicesView())
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if r.ContentLength != 0 {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
			return
		}
	}
	fail := func(code int, msg string) { writeJSON(w, code, map[string]string{"error": msg}) }
	switch r.URL.Path {
	case "/api/phone/devices/pairing":
		domain, ok := phone.configured()
		if !ok {
			fail(http.StatusBadRequest, "configure o servidor do celular primeiro (linha do servidor e senha)")
			return
		}
		tok, exp, err := phone.pairCreate()
		if err != nil {
			fail(http.StatusInternalServerError, err.Error())
			return
		}
		link := "https://" + domain + "/#pair=" + tok
		qrImg, err := totpQR(link)
		if err != nil {
			fail(http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"link": link, "qr": qrImg, "expires_at": exp.UTC().Format(time.RFC3339),
			"ttl_seconds": int(pairTTL / time.Second),
		})
		return
	case "/api/phone/devices/pairing/cancel":
		phone.pairCancel()
	case "/api/phone/devices/rename":
		if err := phone.renameDevice(strings.TrimSpace(req.ID), req.Name); err != nil {
			fail(http.StatusBadRequest, err.Error())
			return
		}
	case "/api/phone/devices/revoke":
		if strings.TrimSpace(req.ID) == "" || !phone.revokeDevice(strings.TrimSpace(req.ID)) {
			fail(http.StatusNotFound, "aparelho não encontrado")
			return
		}
	case "/api/phone/devices/revoke-all":
		phone.revokeAllDevices()
	}
	writeJSON(w, http.StatusOK, phoneDevicesView())
}
