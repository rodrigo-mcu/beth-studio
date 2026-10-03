package main

import (
	"encoding/json"
	"net/http"
	"strings"
)

// serveAPI: appearance endpoints (auth, Host and Origin already checked).
//
//	GET  /api/themes[?reload=1]      -> {"themes":[Theme...]}
//	GET  /api/fonts[?reload=1]       -> {"fonts":[{family,mono}],"presets":[...]}
//	GET  /api/settings               -> SettingsSnapshot
//	POST /api/settings/default       {theme,font_family,font_size}
//	POST /api/settings/pane          {pane_id,theme,font_family,font_size} (all empty = clear)
//	POST /api/favorites/theme        {id,favorite}
//	POST /api/favorites/font         {family,favorite}
func (s *server) serveAPI(w http.ResponseWriter, r *http.Request) {
	reload := r.URL.Query().Get("reload") == "1"
	if r.Method == http.MethodGet {
		switch r.URL.Path {
		case "/api/themes":
			b, _ := themes.get(reload)
			writeRawJSON(w, b)
		case "/api/fonts":
			writeRawJSON(w, fonts.get(reload))
		case "/api/settings":
			writeJSON(w, http.StatusOK, settings.snapshot())
		default:
			http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		}
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		return
	}
	// JSON only: a cross-site HTML form cannot send this content type.
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "use application/json", http.StatusUnsupportedMediaType)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 512<<10)
	var req struct {
		PaneID      *int       `json:"pane_id"`
		Layout      *WebLayout `json:"layout"`
		Mode        string     `json:"mode"`
		SizeMode    string     `json:"size_mode"`
		Bold        *bool      `json:"font_bold"`
		View        string     `json:"view"`
		Kinds       []string   `json:"kinds"`
		Collapsed   bool       `json:"collapsed"`
		Width       int        `json:"width"`
		ThemeID     string     `json:"theme_id"`
		Theme       string     `json:"theme"`
		Family      string     `json:"font_family"`
		Size        float64    `json:"font_size"`
		ID          string     `json:"id"`
		FontFam     string     `json:"family"`
		Favorite    bool       `json:"favorite"`
		PaneIDs     []int      `json:"pane_ids"`
		KindOrder   []string   `json:"kind_order"`
		SplitByKind *bool      `json:"split_by_kind"`
		Name        string     `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
		return
	}
	var (
		snap        SettingsSnapshot
		err         error
		pushPalette bool
	)
	a := Appearance{Theme: req.Theme, FontFamily: req.Family, FontSize: req.Size, SizeMode: req.SizeMode, FontBold: req.Bold}
	switch r.URL.Path {
	case "/api/settings/default":
		snap, err = settings.setDefault(a)
		pushPalette = err == nil
	case "/api/settings/pane":
		if req.PaneID == nil || *req.PaneID < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "pane_id obrigatório"})
			return
		}
		snap, err = settings.setPane(*req.PaneID, a)
		pushPalette = err == nil
	case "/api/favorites/theme":
		snap, err = settings.setThemeFavorite(req.ID, req.Favorite)
	case "/api/favorites/font":
		snap, err = settings.setFontFavorite(req.FontFam, req.Favorite)
	case "/api/layout":
		snap, err = settings.setLayout(req.Layout)
	case "/api/settings/pane-names":
		snap, err = settings.setPaneNames(req.PaneIDs, req.Name)
	case "/api/settings/sidebar":
		snap, err = settings.setSidebar(SidebarPrefs{Collapsed: req.Collapsed, Width: req.Width, View: req.View, Kinds: req.Kinds,
			KindOrder: req.KindOrder, SplitByKind: req.SplitByKind})
	case "/api/settings/ui":
		snap, err = settings.setUITheme(UITheme{Mode: req.Mode, ThemeID: req.ThemeID})
		// terminais sem tema proprio seguem a interface (studioTermTheme)
		pushPalette = err == nil
	case "/api/settings/clear-panes":
		var n int
		snap, n, err = settings.clearPanes()
		if err == nil {
			s.hub.syncPalettes()
			writeJSON(w, http.StatusOK, map[string]any{"cleared": n, "settings": snap})
			return
		}
	default:
		http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if pushPalette {
		s.hub.syncPalettes()
	}
	writeJSON(w, http.StatusOK, snap)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeRawJSON(w http.ResponseWriter, b []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(b)
}
