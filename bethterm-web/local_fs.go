package main

// local_fs.go — listagem do disco local para a janela SFTP dual-pane.
//
//	POST /api/local-fs/list  {path?}  -> {path, parent, entries, roots?}
//	POST /api/local-fs/mkdir {path}
//	POST /api/local-fs/remove {path, is_dir}
//	POST /api/local-fs/reveal {path}
//
// path vazio = pasta do usuario (USERPROFILE). Sem caminho relativo fora
// de unidades/UNC; sem "..".

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"unicode"
)

type localFSEntry struct {
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	IsDir bool   `json:"is_dir"`
	Mode  string `json:"mode,omitempty"`
	MTime int64  `json:"mtime"`
}

func (s *server) serveLocalFS(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "use POST", http.StatusMethodNotAllowed)
		return
	}
	var body map[string]any
	if !sshDecodePOST(w, r, &body) {
		return
	}
	str := func(k string) string { v, _ := body[k].(string); return strings.TrimSpace(v) }
	switch r.URL.Path {
	case "/api/local-fs/list":
		dir := str("path")
		if dir == "" {
			dir = os.Getenv("USERPROFILE")
			if dir == "" {
				dir = "C:\\"
			}
		}
		clean, err := localFSClean(dir)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		infos, err := os.ReadDir(clean)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		out := make([]localFSEntry, 0, len(infos))
		for _, e := range infos {
			info, err := e.Info()
			if err != nil {
				continue
			}
			out = append(out, localFSEntry{
				Name:  e.Name(),
				Size:  info.Size(),
				IsDir: e.IsDir(),
				Mode:  info.Mode().String(),
				MTime: info.ModTime().Unix(),
			})
		}
		sort.SliceStable(out, func(i, j int) bool {
			if out[i].IsDir != out[j].IsDir {
				return out[i].IsDir
			}
			return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
		})
		parent := filepath.Dir(clean)
		if parent == clean {
			parent = ""
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"path": clean, "parent": parent, "entries": out, "roots": localFSRoots(),
			"home": os.Getenv("USERPROFILE"), "wsl": localFSWSLRoots(),
		})
	case "/api/local-fs/mkdir":
		p, err := localFSClean(str("path"))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if err := os.MkdirAll(p, 0o755); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case "/api/local-fs/remove":
		p, err := localFSClean(str("path"))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		isDir, _ := body["is_dir"].(bool)
		if isDir {
			err = os.RemoveAll(p)
		} else {
			err = os.Remove(p)
		}
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case "/api/local-fs/reveal":
		p, err := localFSClean(str("path"))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if _, err := os.Stat(p); err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "arquivo não encontrado"})
			return
		}
		if err := revealInExplorer(p, true); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		http.NotFound(w, r)
	}
}

func localFSClean(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" || strings.ContainsRune(p, 0) || len(p) > 4096 {
		return "", errors.New("caminho inválido")
	}
	if runtime.GOOS == "windows" {
		// "C:" sozinho -> "C:\"
		if len(p) == 2 && unicode.IsLetter(rune(p[0])) && p[1] == ':' {
			p += `\`
		}
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	clean := filepath.Clean(abs)
	if strings.Contains(clean, "..") {
		return "", errors.New("caminho inválido")
	}
	return clean, nil
}

// localFSWSLRoots: a raiz de cada distro WSL (\\wsl.localhost\<distro>\),
// para o navegador de pastas chegar no /home de dentro do Linux.
func localFSWSLRoots() []string {
	var out []string
	for _, d := range listWSLDistros() {
		out = append(out, `\\wsl.localhost\`+d+`\`)
	}
	return out
}

func localFSRoots() []string {
	if runtime.GOOS != "windows" {
		return []string{"/"}
	}
	var out []string
	for c := 'A'; c <= 'Z'; c++ {
		root := string(c) + `:\`
		if st, err := os.Stat(root); err == nil && st.IsDir() {
			out = append(out, root)
		}
	}
	return out
}
