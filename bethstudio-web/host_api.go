package main

// host_api.go — estado do host e "Tentar de novo" para a interface. Só no
// PC: o Studio remoto e o celular recebem 403.

import (
	"net/http"
)

func (s *server) serveHost(w http.ResponseWriter, r *http.Request, remoteKey string) {
	if remoteKey != "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "o host só é controlado no computador"})
		return
	}
	sup := s.hub.sup
	switch r.URL.Path {
	case "/api/host/state":
		if r.Method != http.MethodGet {
			http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
			return
		}
		if sup == nil {
			writeJSON(w, http.StatusOK, map[string]string{"state": "unmanaged", "message": ""})
			return
		}
		st, msg := sup.State()
		writeJSON(w, http.StatusOK, map[string]string{"state": string(st), "message": msg})
	case "/api/host/retry":
		if r.Method != http.MethodPost {
			http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
			return
		}
		if sup == nil {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "esta janela não supervisiona o host"})
			return
		}
		go sup.Retry() // a tentativa pode levar 8 s; a resposta não espera
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		http.NotFound(w, r)
	}
}
