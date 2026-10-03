package main

// ssh_api.go — rotas /api/ssh/... da tela SSH (token, Host e Origin ja'
// conferidos pelo server.go). Credenciais entram (para o cofre) mas nunca
// saem: a resposta so' traz has_password / has_passphrase.
//
//	GET  /api/ssh/hosts                 -> {hosts, recent, hosts_file, known_hosts_file}
//	POST /api/ssh/hosts/save            {host, password, save_password, clear_password,
//	                                     passphrase, save_passphrase, clear_passphrase} -> {host}
//	POST /api/ssh/hosts/delete          {id}
//	POST /api/ssh/hosts/duplicate       {id} -> {host}
//	GET  /api/ssh/config-import         -> {path, candidates}
//	POST /api/ssh/config-import         {aliases:[...]} -> {imported}
//	(demais: ssh_net_api.go — testar, confiar na chave, SFTP)

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
)

const sshJSONLimit = 256 << 10

// sshReadOnlyOK: o que --read-only permite (nada que grave no disco ou mude o
// servidor remoto).
func sshReadOnlyOK(r *http.Request) bool {
	switch r.URL.Path {
	case "/api/ssh/hosts", "/api/ssh/hosts/test", "/api/ssh/sftp/list":
		return true
	case "/api/ssh/config-import":
		return r.Method == http.MethodGet
	}
	return false
}

func (s *server) serveSSH(w http.ResponseWriter, r *http.Request) {
	if s.hub != nil && s.hub.readOnly && !sshReadOnlyOK(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "modo somente leitura"})
		return
	}
	switch r.URL.Path {
	case "/api/ssh/hosts":
		if r.Method != http.MethodGet {
			http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
			return
		}
		hosts, recent, err := sshListHosts()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"hosts": hosts, "recent": recent, "hosts_file": sshHostsPath(), "known_hosts_file": sshKnownPath()})
	case "/api/ssh/hosts/save":
		var req struct {
			Host            SSHSavedHost `json:"host"`
			Password        string       `json:"password"`
			SavePassword    bool         `json:"save_password"`
			ClearPassword   bool         `json:"clear_password"`
			Passphrase      string       `json:"passphrase"`
			SavePassphrase  bool         `json:"save_passphrase"`
			ClearPassphrase bool         `json:"clear_passphrase"`
		}
		if !sshDecodePOST(w, r, &req) {
			return
		}
		h, err := sshUpsertHost(req.Host)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		var serr error
		switch {
		case req.ClearPassword || h.Auth != sshAuthPassword:
			serr = sshSecretSet(sshSecretPw, h.ID, "")
		case req.SavePassword && req.Password != "":
			serr = sshSecretSet(sshSecretPw, h.ID, req.Password)
		}
		switch {
		case serr != nil:
		case req.ClearPassphrase || h.Auth != sshAuthKey:
			serr = sshSecretSet(sshSecretPass, h.ID, "")
		case req.SavePassphrase && req.Passphrase != "":
			serr = sshSecretSet(sshSecretPass, h.ID, req.Passphrase)
		}
		if serr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "host salvo, mas a credencial não: " + serr.Error()})
			return
		}
		sshFillDerived(&h)
		writeJSON(w, http.StatusOK, map[string]any{"host": h})
	case "/api/ssh/hosts/delete":
		var req struct {
			ID string `json:"id"`
		}
		if !sshDecodePOST(w, r, &req) {
			return
		}
		if err := sshDeleteHost(req.ID); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case "/api/ssh/hosts/duplicate":
		var req struct {
			ID string `json:"id"`
		}
		if !sshDecodePOST(w, r, &req) {
			return
		}
		h, err := sshDuplicateHost(req.ID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"host": h})
	case "/api/ssh/config-import":
		s.serveSSHConfigImport(w, r)
	default:
		s.serveSSHNet(w, r)
	}
}

func (s *server) serveSSHConfigImport(w http.ResponseWriter, r *http.Request) {
	path := sshConfigPath()
	hosts, _, err := sshListHosts()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	var text string
	if b, err := os.ReadFile(path); err == nil {
		text = string(b)
	} else if !errors.Is(err, os.ErrNotExist) {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "não foi possível ler " + path + ": " + err.Error()})
		return
	}
	cands := sshConfigCandidates(text, hosts)
	if cands == nil {
		cands = []SSHConfigCandidate{}
	}
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, map[string]any{"path": path, "candidates": cands})
		return
	}
	var req struct {
		Aliases []string `json:"aliases"`
	}
	if !sshDecodePOST(w, r, &req) {
		return
	}
	want := map[string]bool{}
	for _, a := range req.Aliases {
		want[strings.ToLower(a)] = true
	}
	n := 0
	var errs []string
	for _, c := range cands {
		if !want[strings.ToLower(c.Alias)] {
			continue
		}
		if _, err := sshUpsertHost(c.Host); err != nil {
			errs = append(errs, c.Alias+": "+err.Error())
			continue
		}
		n++
	}
	writeJSON(w, http.StatusOK, map[string]any{"imported": n, "errors": errs})
}

// sshDecodePOST: POST + application/json (um formulario de outro site nao
// consegue mandar esse tipo) + limite de tamanho.
func sshDecodePOST(w http.ResponseWriter, r *http.Request, v any) bool {
	if r.Method != http.MethodPost {
		http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		return false
	}
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "use application/json", http.StatusUnsupportedMediaType)
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, sshJSONLimit)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
		return false
	}
	return true
}
