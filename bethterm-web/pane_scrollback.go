package main

// pane_scrollback.go — historico completo de um pane (patch 0188) para o
// menu do Studio: copiar / salvar como .txt.
//
//	POST /api/pane/scrollback      {pane_id}           -> {text}
//	POST /api/pane/scrollback/save {pane_id, title?}   -> dialogo Salvar como
//	POST /api/pane/screenshot/save {png_base64, title?} -> dialogo Salvar PNG
//
// O texto vem da ponte (`op:scrollback`). A imagem e' capturada no browser
// (canvas do xterm) e enviada em base64; o Go so' mostra o dialogo e grava.

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
)

const scrollbackTimeout = 20 * time.Second

var scrollbackTitleSafe = regexp.MustCompile(`[^A-Za-z0-9._\-]+`)

func (s *server) servePaneScrollback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "use POST", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		PaneID int    `json:"pane_id"`
		Title  string `json:"title"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req) != nil || req.PaneID < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
		return
	}
	text, err := s.hub.requestScrollback(req.PaneID, scrollbackTimeout)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	if r.URL.Path == "/api/pane/scrollback/save" {
		name := scrollbackFileName(req.Title, req.PaneID)
		path, ok, err := nativeSaveDialog(name, ".txt")
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if !ok {
			writeJSON(w, http.StatusOK, map[string]any{"cancelled": true})
			return
		}
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"saved": path})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"text": text})
}

func (s *server) servePaneScreenshotSave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "use POST", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		PNG   string `json:"png_base64"`
		Title string `json:"title"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<20)).Decode(&req) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
		return
	}
	raw := strings.TrimSpace(req.PNG)
	if i := strings.Index(raw, ","); i >= 0 && strings.Contains(raw[:i], "base64") {
		raw = raw[i+1:]
	}
	data, err := base64.StdEncoding.DecodeString(raw)
	if err != nil || len(data) < 8 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "imagem inválida"})
		return
	}
	name := scrollbackFileName(req.Title, 0)
	name = strings.TrimSuffix(name, ".txt") + ".png"
	path, ok, err := nativeSaveDialog(name, ".png")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"cancelled": true})
		return
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"saved": path})
}

func scrollbackFileName(title string, paneID int) string {
	stamp := time.Now().UTC().Format("20060102-150405")
	t := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.TrimSpace(title))
	t = scrollbackTitleSafe.ReplaceAllString(t, "-")
	t = strings.Trim(t, "-._")
	if len(t) > 40 {
		t = t[:40]
	}
	if t == "" {
		if paneID > 0 {
			return "bethterm-pane-" + strconv.Itoa(paneID) + "-" + stamp + ".txt"
		}
		return "bethterm-" + stamp + ".txt"
	}
	return "bethterm-" + t + "-" + stamp + ".txt"
}
