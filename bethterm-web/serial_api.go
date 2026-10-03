package main

// serial_api.go — rotas /api/serial/... da tela Serial.
//
//	GET  /api/serial/profiles            -> {profiles, recent, profiles_file}
//	GET  /api/serial/ports               -> {ports:[{port, friendly_name, manufacturer, vid, pid, serial_number}]}
//	POST /api/serial/profiles/save       {profile} -> {profile}
//	POST /api/serial/profiles/delete     {id}
//	POST /api/serial/profiles/duplicate  {id} -> {profile}
//
// "Conectar" nao passa por aqui: e' o op de WebSocket spawn_tool
// (tool_spawn.go), que cria o terminal no host.

import (
	"net/http"
)

func (s *server) serveSerial(w http.ResponseWriter, r *http.Request) {
	if s.hub != nil && s.hub.readOnly && r.Method != http.MethodGet {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "modo somente leitura"})
		return
	}
	switch r.URL.Path {
	case "/api/serial/profiles":
		if r.Method != http.MethodGet {
			http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
			return
		}
		ps, rec, err := serialListProfiles()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"profiles": ps, "recent": rec, "profiles_file": serialProfilesPath()})
	case "/api/serial/ports":
		if r.Method != http.MethodGet {
			http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
			return
		}
		ports, err := serialListPorts()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "não foi possível listar as portas: " + err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ports": ports})
	case "/api/serial/profiles/save":
		var req struct {
			Profile SerialProfile `json:"profile"`
		}
		if !sshDecodePOST(w, r, &req) {
			return
		}
		p, err := serialUpsertProfile(req.Profile)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"profile": p})
	case "/api/serial/profiles/delete", "/api/serial/profiles/duplicate":
		var req struct {
			ID string `json:"id"`
		}
		if !sshDecodePOST(w, r, &req) {
			return
		}
		if r.URL.Path == "/api/serial/profiles/delete" {
			if err := serialDeleteProfile(req.ID); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
			return
		}
		p, err := serialDuplicateProfile(req.ID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"profile": p})
	default:
		http.Error(w, "não encontrado", http.StatusNotFound)
	}
}
