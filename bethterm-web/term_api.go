package main

// term_api.go — API das janelas de terminal destacadas. Só no PC (o Studio
// remoto e o celular recebem 403). Fechar/focar age na JANELA; nenhuma rota
// daqui encerra um terminal no host.

import (
	"encoding/json"
	"net/http"
)

// openTermWindow abre (ou foca) a janela do pane; trocado nos testes.
var openTermWindow = launchTermWindow

// screenToStudioClient converte pixels de tela em pixels da área cliente da
// janela do Studio; trocado nos testes.
var screenToStudioClient = studioScreenToClient

type termReq struct {
	PaneID *int `json:"pane_id"`
	X      int  `json:"x"`
	Y      int  `json:"y"`
	End    bool `json:"end"`
	Attach bool `json:"attach"`
}

func (s *server) serveTerm(w http.ResponseWriter, r *http.Request, remoteKey string) {
	if remoteKey != "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "janela destacada só no computador"})
		return
	}
	if r.URL.Path == "/api/term/list" {
		if r.Method != http.MethodGet {
			http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"panes": s.hub.term.Panes()})
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		return
	}
	var req termReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil || req.PaneID == nil || *req.PaneID < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "pane_id inválido"})
		return
	}
	pane := *req.PaneID
	switch r.URL.Path {
	case "/api/term/detach":
		if s.hub.readOnly {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "modo somente leitura"})
			return
		}
		if s.hub.term.Has(pane) {
			s.hub.term.Focus(pane)
		} else if err := openTermWindow(s, pane); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case "/api/term/focus":
		writeJSON(w, http.StatusOK, map[string]bool{"ok": s.hub.term.Focus(pane)})
	case "/api/term/close":
		writeJSON(w, http.StatusOK, map[string]bool{"ok": s.hub.term.Close(pane)})
	case "/api/term/drag":
		cx, cy := req.X, req.Y
		if !req.Attach {
			var ok bool
			if cx, cy, ok = screenToStudioClient(req.X, req.Y); !ok {
				cx, cy = -1, -1
			}
		}
		s.hub.broadcast(map[string]any{"ev": "term_drag", "pane": pane, "x": cx, "y": cy, "end": req.End, "attach": req.Attach})
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		http.NotFound(w, r)
	}
}
