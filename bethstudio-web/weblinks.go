package main

// weblinks.go — caminho unico para abrir qualquer link http(s) que aparecer
// na propria interface (aparencia, cartoes de modelo, o que mais precisar)
// no navegador padrao do sistema, NUNCA dentro da janela do app. O
// navegador ja bloqueia navegacao para fora da propria origem em duas
// camadas (webhost_windows.go): NavigationStarting (a janela principal) e
// NewWindowRequested (qualquer popup/target=_blank/window.open); esta rota
// e' o que o clique na pagina chama antes de tudo.

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
)

// validateExternalURL: so' http(s), com host — nunca file://, javascript:,
// data: etc. (isso e' arquivo local, tratado por local-file.go).
func validateExternalURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", errors.New("link inválido (só http ou https)")
	}
	return u.String(), nil
}

func serveOpenLink(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "use POST application/json", http.StatusBadRequest)
		return
	}
	var req struct {
		URL string `json:"url"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
		return
	}
	u, err := validateExternalURL(req.URL)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	openInSystemBrowser(u)
	writeJSON(w, http.StatusOK, map[string]string{"url": u})
}
