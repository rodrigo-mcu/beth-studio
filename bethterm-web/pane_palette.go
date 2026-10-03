package main

import (
	"strconv"
	"strings"
)

// factoryTermTheme matches frontend DEFAULT_TERM_THEME (VS Code Dark).
// Used when a pane has no Studio theme so OSC 11 still matches the screen.
var factoryTermTheme = XtermTheme{
	Background:          "#1E1E1E",
	Foreground:          "#D4D4D4",
	Cursor:              "#AEAFAD",
	SelectionBackground: "#3A3D41",
	SelectionForeground: "#FFFFFF",
	Black:               "#000000",
	Red:                 "#CD3131",
	Green:               "#00B050",
	Yellow:              "#E5E510",
	Blue:                "#0070DD",
	Magenta:             "#BC3FBC",
	Cyan:                "#00B0F0",
	White:               "#D4D4D4",
	BrightBlack:         "#808080",
	BrightRed:           "#FF6363",
	BrightGreen:         "#00E26E",
	BrightYellow:        "#FFF477",
	BrightBlue:          "#63B2FF",
	BrightMagenta:       "#FF77FF",
	BrightCyan:          "#63D7FF",
	BrightWhite:         "#FFFFFF",
}

func (c XtermTheme) ansi() []string {
	return []string{
		c.Black, c.Red, c.Green, c.Yellow, c.Blue, c.Magenta, c.Cyan, c.White,
		c.BrightBlack, c.BrightRed, c.BrightGreen, c.BrightYellow,
		c.BrightBlue, c.BrightMagenta, c.BrightCyan, c.BrightWhite,
	}
}

// paletteForTheme resolves the colours agents should see. An empty id is
// the Studio factory theme (dark). Unknown ids are skipped.
func paletteForTheme(id string) (XtermTheme, bool) {
	if id == "" {
		return factoryTermTheme, true
	}
	t, ok := themes.has(id)
	if !ok || t.Colors.Background == "" || t.Colors.Foreground == "" {
		return XtermTheme{}, false
	}
	return t.Colors, true
}

// studioLightTermTheme: terminal theme for the "light" interface mode.
const studioLightTermTheme = "vscode_light"

// studioTermTheme is the terminal theme that follows the Beth Studio
// interface, for panes with no theme of their own and no terminal default:
// the interface theme, the light built-in in "light" mode, the factory ("")
// in the dark modes. "follow" means the interface follows the terminals, so
// it adds nothing. Mirror of studioTermTheme in frontend/src/lib/uiTheme.ts.
func studioTermTheme(u *UITheme) string {
	if u == nil {
		return ""
	}
	switch legacyUIMode(u.Mode) {
	case "theme":
		return strings.TrimSpace(u.ThemeID)
	case "light":
		return studioLightTermTheme
	}
	return ""
}

// defaultTermThemeLocked: terminal default, otherwise the Studio interface.
func (st *settingsStore) defaultTermThemeLocked() string {
	if st.s.Default.Theme != "" {
		return st.s.Default.Theme
	}
	return studioTermTheme(st.s.UITheme)
}

// effectiveThemeIDs is the Studio theme for each live pane: the pane's own
// theme, otherwise the terminal default, otherwise the interface theme
// ("" = factory).
func (st *settingsStore) effectiveThemeIDs() map[int]string {
	st.mu.Lock()
	defer st.mu.Unlock()
	out := make(map[int]string, len(st.live))
	def := st.defaultTermThemeLocked()
	for id := range st.live {
		theme := def
		if p := st.s.Panes[strconv.Itoa(id)]; p != nil && p.Theme != "" {
			theme = p.Theme
		}
		out[id] = theme
	}
	return out
}

// syncPalettes pushes each live pane's Studio colours to the host so OSC
// 10/11 queries (Codex, Cursor, …) match the theme on screen, including
// light themes. Safe to call often: unchanged panes are skipped.
func (h *hub) syncPalettes() {
	if h == nil || h.bridge == nil || h.readOnly {
		return
	}
	for id, themeID := range settings.effectiveThemeIDs() {
		h.pushPalette(id, themeID)
	}
}

func (h *hub) pushPalette(paneID int, themeID string) {
	colors, ok := paletteForTheme(themeID)
	if !ok {
		return
	}
	key := themeID + "\x00" + colors.Background + "\x00" + colors.Foreground
	h.mu.Lock()
	if h.paletteSent == nil {
		h.paletteSent = map[int]string{}
	}
	if h.paletteSent[paneID] == key {
		h.mu.Unlock()
		return
	}
	h.paletteSent[paneID] = key
	h.mu.Unlock()
	err := h.bridge.write(map[string]any{
		"op":         "palette",
		"pane_id":    paneID,
		"background": colors.Background,
		"foreground": colors.Foreground,
		"cursor":     colors.Cursor,
		"ansi":       colors.ansi(),
	})
	if err != nil {
		h.mu.Lock()
		delete(h.paletteSent, paneID)
		h.mu.Unlock()
	}
}
