package main

// uiboot.go — o primeiro quadro ja' sai com as cores certas.
//
// A UI calcula as cores da interface (Escuro, Claro, Azul-marinho, seguir o tema dos
// terminais, tema escolhido) e manda o resultado para o Go (POST
// /api/settings/ui-css). O Go guarda em web-settings.json ("ui_css") e:
//   - injeta um <style> no index.html servido, com as variaveis CSS e o
//     fundo, antes de qualquer JS rodar;
//   - passa o fundo para o WebView2 (WEBVIEW2_DEFAULT_BACKGROUND_COLOR),
//     que pinta essa cor antes da pagina carregar.
// Sem cache (primeira vez), valem os padroes neutros do index.css.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"regexp"
	"sort"
	"strings"

	"bethterm-web/webui"
)

type UICSS struct {
	Vars map[string]string `json:"vars"` // token -> "r g b"
	Bg   string            `json:"bg"`   // #rrggbb
}

var (
	uiTokenRe = regexp.MustCompile(`^[a-z0-9-]{1,24}$`)
	rgbRe     = regexp.MustCompile(`^\d{1,3} \d{1,3} \d{1,3}$`)
	hexRe     = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
)

func cleanUICSS(u UICSS) (UICSS, error) {
	if len(u.Vars) > 40 {
		return u, errors.New("variáveis demais")
	}
	for k, v := range u.Vars {
		if !uiTokenRe.MatchString(k) || !rgbRe.MatchString(v) {
			return u, fmt.Errorf("variável inválida: %s", k)
		}
	}
	if !hexRe.MatchString(u.Bg) {
		return u, errors.New("fundo inválido")
	}
	return u, nil
}

func (st *settingsStore) setUICSS(u UICSS) error {
	u, err := cleanUICSS(u)
	if err != nil {
		return err
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	st.reloadLocked()
	st.s.UICSS = &u
	return st.saveLocked()
}

func (st *settingsStore) uiCSS() *UICSS {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.s.UICSS
}

// bootStyle: <style> com as variaveis salvas (vazio sem cache).
func bootStyle(u *UICSS) string {
	if u == nil {
		return ""
	}
	keys := make([]string, 0, len(u.Vars))
	for k := range u.Vars {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(`<style id="bt-boot">:root{`)
	for _, k := range keys {
		fmt.Fprintf(&b, "--bt-%s:%s;", k, u.Vars[k])
	}
	fmt.Fprintf(&b, "}html,body,#root{background:%s}</style>", u.Bg)
	return b.String()
}

// serveIndex entrega o index.html com o <style> de boot no <head>.
func (s *server) serveIndex(w http.ResponseWriter) {
	b, err := fs.ReadFile(webui.Dist, "dist/index.html")
	if err != nil {
		http.Error(w, "index.html ausente", http.StatusInternalServerError)
		return
	}
	html := strings.Replace(string(b), "</head>", bootStyle(settings.uiCSS())+"</head>", 1)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(html))
}

// webviewBackground: "AARRGGBB" para WEBVIEW2_DEFAULT_BACKGROUND_COLOR.
func webviewBackground(u *UICSS) string {
	bg := "#1E1E1E"
	if u != nil && hexRe.MatchString(u.Bg) {
		bg = u.Bg
	}
	return "FF" + strings.ToUpper(bg[1:])
}

func (s *server) serveUICSS(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "use POST application/json", http.StatusBadRequest)
		return
	}
	var u UICSS
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&u); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
		return
	}
	if err := settings.setUICSS(u); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
