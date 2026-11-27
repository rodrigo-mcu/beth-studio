package main

// editor_window.go — editor de arquivos em janela separada (Configurações >
// Aparência > Editor de arquivos > Janela separada).
//
//	API: POST /api/editor/window {path, edit} -> {ok:true}
//	CLI: bethstudio-web.exe --editor <caminho> [--editor-edit]
//
// Cada arquivo abre num processo deste exe, com janela própria do Windows
// que sai da janela do Studio (outro monitor, por exemplo). O mesmo arquivo
// de novo só traz a janela dele para a frente. Não sobe ponte com o host.

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
)

func serveEditorWindow(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "use POST application/json", http.StatusBadRequest)
		return
	}
	var req struct {
		Path string `json:"path"`
		Edit bool   `json:"edit"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
		return
	}
	path, err := validateLocalPath(req.Path)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	path, err = openRegularFile(path)
	if err != nil {
		writeLocalFileOpError(w, err)
		return
	}
	if err := openEditorWindow(path, req.Edit); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// editorWindowTitle: o título identifica a janela do arquivo (FindWindow).
func editorWindowTitle(path string) string {
	return filepath.Base(path) + " — " + filepath.Dir(path)
}
