package main

// themes.go — the same theme sources the BethTerm GUI sees, converted to the
// xterm.js ITheme shape with the GUI's own mapping rules:
//
//   - the 3 built-ins of wtinator/src/vscode_theme.rs (vscode_light,
//     vscode_dark, windows_terminal_dark), with their exact colours;
//   - every <id>.json in <data dir>\themes (Gogh catalog saved by
//     wtinator/src/theme_download.rs: 16 ansi + fg/bg/cursor). Selection is
//     re-derived exactly like `palette_from_saved` / `derive_selection_colors`.
//
// Plus (web only, the GUI does not read them yet) the colour themes of the
// installed VS Code / Cursor / VSCodium extensions, including VS Code's own
// built-in themes. Their `terminal.ansi*`, `terminal.background`,
// `terminal.foreground`, `terminalCursor.*` and `terminal.selection*` keys map
// 1:1; missing keys fall back like VS Code does (panel/editor background,
// editor foreground) and missing ANSI colours come from the GUI's
// vscode_dark / vscode_light tables.

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// XtermTheme is xterm.js ITheme (only the keys we fill).
type XtermTheme struct {
	Background          string `json:"background"`
	Foreground          string `json:"foreground"`
	Cursor              string `json:"cursor"`
	CursorAccent        string `json:"cursorAccent"`
	SelectionBackground string `json:"selectionBackground"`
	SelectionForeground string `json:"selectionForeground,omitempty"`
	Black               string `json:"black"`
	Red                 string `json:"red"`
	Green               string `json:"green"`
	Yellow              string `json:"yellow"`
	Blue                string `json:"blue"`
	Magenta             string `json:"magenta"`
	Cyan                string `json:"cyan"`
	White               string `json:"white"`
	BrightBlack         string `json:"brightBlack"`
	BrightRed           string `json:"brightRed"`
	BrightGreen         string `json:"brightGreen"`
	BrightYellow        string `json:"brightYellow"`
	BrightBlue          string `json:"brightBlue"`
	BrightMagenta       string `json:"brightMagenta"`
	BrightCyan          string `json:"brightCyan"`
	BrightWhite         string `json:"brightWhite"`
}

// Theme is one entry of GET /api/themes.
type Theme struct {
	ID     string     `json:"id"`
	Name   string     `json:"name"`
	Source string     `json:"source"` // builtin | gogh | vscode
	Detail string     `json:"detail,omitempty"`
	Dark   bool       `json:"dark"`
	GUI    bool       `json:"gui"` // the BethTerm GUI knows this id
	Colors XtermTheme `json:"colors"`
	// UI: VS Code workbench colours used to derive the web interface theme
	// ("Seguir o tema dos terminais" / "Escolher um tema…"). Only VS Code
	// themes have them; the others are derived from the terminal colours.
	UI map[string]string `json:"ui,omitempty"`
}

func (t *XtermTheme) setANSI(a [16]string) {
	t.Black, t.Red, t.Green, t.Yellow, t.Blue, t.Magenta, t.Cyan, t.White = a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]
	t.BrightBlack, t.BrightRed, t.BrightGreen, t.BrightYellow = a[8], a[9], a[10], a[11]
	t.BrightBlue, t.BrightMagenta, t.BrightCyan, t.BrightWhite = a[12], a[13], a[14], a[15]
}

// ---------------------------------------------------------------------------
// colour helpers (same maths as wtinator: sRGB lerp, BT.601 luminance)
// ---------------------------------------------------------------------------

type rgb struct{ r, g, b float64 } // 0..1

func parseHex(s string) (rgb, bool) {
	h := strings.TrimPrefix(strings.TrimSpace(s), "#")
	expand := func(c byte) string { return string([]byte{c, c}) }
	switch len(h) {
	case 3, 4:
		h = expand(h[0]) + expand(h[1]) + expand(h[2])
	case 6, 8:
		h = h[:6]
	default:
		return rgb{}, false
	}
	v, err := strconv.ParseUint(h, 16, 32)
	if err != nil {
		return rgb{}, false
	}
	return rgb{float64(v>>16&0xff) / 255, float64(v>>8&0xff) / 255, float64(v&0xff) / 255}, true
}

func (c rgb) hex() string {
	f := func(x float64) int { return int(math.Round(math.Max(0, math.Min(1, x)) * 255)) }
	return fmt.Sprintf("#%02x%02x%02x", f(c.r), f(c.g), f(c.b))
}

func (c rgb) lum() float64 { return 0.299*c.r + 0.587*c.g + 0.114*c.b }

func (c rgb) lerp(o rgb, k float64) rgb {
	return rgb{c.r + k*(o.r-c.r), c.g + k*(o.g-c.g), c.b + k*(o.b-c.b)}
}

// deriveSelection ports theme_download::derive_selection_colors.
func deriveSelection(fgHex, bgHex string) (string, string) {
	fg, ok := parseHex(fgHex)
	if !ok {
		fg = rgb{0.9, 0.9, 0.9}
	}
	bg, ok := parseHex(bgHex)
	if !ok {
		bg = rgb{0.1, 0.1, 0.1}
	}
	bgL, fgL := bg.lum(), fg.lum()
	mix := 0.35
	sel := bg.lerp(fg, mix)
	for math.Abs(sel.lum()-bgL) < 0.20 && mix < 1.0 {
		mix += 0.05
		sel = bg.lerp(fg, mix)
	}
	if math.Abs(fgL-bgL) < 0.05 {
		fb := rgb{1, 1, 1}
		if bgL > 0.5 {
			fb = rgb{0, 0, 0}
		}
		sel = bg.lerp(fb, 0.40)
	}
	return fg.hex(), sel.hex()
}

// normHex: "#RRGGBB" / "#RGB" (drops alpha) or "" when invalid.
func normHex(s string) string {
	c, ok := parseHex(s)
	if !ok {
		return ""
	}
	return c.hex()
}

// ---------------------------------------------------------------------------
// built-ins (wtinator/src/vscode_theme.rs)
// ---------------------------------------------------------------------------

var (
	guiDarkANSI = [16]string{"#000000", "#cd3131", "#00b050", "#e5e510", "#0070dd", "#bc3fbc", "#00b0f0", "#d4d4d4",
		"#808080", "#ff6363", "#00e26e", "#fff477", "#63b2ff", "#ff77ff", "#63d7ff", "#ffffff"}
	guiLightANSI = [16]string{"#000000", "#cd3131", "#008000", "#b8860b", "#264f78", "#800080", "#008080", "#555555",
		"#808080", "#f14c4c", "#00c800", "#e5b567", "#569cd6", "#c86ec8", "#00bcbc", "#b4b4b4"}
	guiWTANSI = [16]string{"#0c0c0c", "#c50f1f", "#13a10e", "#c19c00", "#0000f0", "#881798", "#3a96dd", "#cccccc",
		"#767676", "#e74856", "#16c60c", "#f9f1a5", "#3b78ff", "#b4009e", "#61d6d6", "#f2f2f2"}
)

func builtinThemes() []Theme {
	mk := func(id, name string, ansi [16]string, fg, bg, cursor, selFg, selBg string, dark bool) Theme {
		t := XtermTheme{Background: bg, Foreground: fg, Cursor: cursor, CursorAccent: bg,
			SelectionBackground: selBg, SelectionForeground: selFg}
		t.setANSI(ansi)
		return Theme{ID: id, Name: name, Source: "builtin", Detail: "BethTerm", Dark: dark, GUI: true, Colors: t}
	}
	return []Theme{
		mk("vscode_light", "VSCode Light", guiLightANSI, "#1f1f1f", "#ffffff", "#000000", "#000000", "#add6ff", false),
		mk("vscode_dark", "VSCode Dark", guiDarkANSI, "#d4d4d4", "#1e1e1e", "#aeafad", "#ffffff", "#264f78", true),
		mk("windows_terminal_dark", "Windows Terminal Dark", guiWTANSI, "#cccccc", "#0c0c0c", "#ffffff", "#ffffff", "#063462", true),
	}
}

// ---------------------------------------------------------------------------
// saved (Gogh) themes: <data dir>\themes\*.json
// ---------------------------------------------------------------------------

type savedTheme struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	ANSI       []string `json:"ansi"`
	Foreground string   `json:"foreground"`
	Background string   `json:"background"`
	Cursor     string   `json:"cursor"`
}

func loadSavedThemes(dir string) []Theme {
	entries, err := os.ReadDir(dir)
	if err != nil {
		log.Printf("themes: %v", err)
		return nil
	}
	var out []Theme
	for _, e := range entries {
		if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var s savedTheme
		if json.Unmarshal(b, &s) != nil || s.ID == "" || len(s.ANSI) != 16 {
			continue
		}
		var ansi [16]string
		ok := true
		for i, h := range s.ANSI {
			if ansi[i] = normHex(h); ansi[i] == "" {
				ok = false
			}
		}
		fg, bg, cur := normHex(s.Foreground), normHex(s.Background), normHex(s.Cursor)
		if !ok || fg == "" || bg == "" || cur == "" { // palette_from_saved returns None
			continue
		}
		selFg, selBg := deriveSelection(fg, bg)
		t := XtermTheme{Background: bg, Foreground: fg, Cursor: cur, CursorAccent: bg,
			SelectionBackground: selBg, SelectionForeground: selFg}
		t.setANSI(ansi)
		bgc, _ := parseHex(bg)
		name := s.Name
		if name == "" {
			name = s.ID
		}
		out = append(out, Theme{ID: s.ID, Name: name, Source: "gogh", Detail: "Gogh", Dark: bgc.lum() < 0.5, GUI: true, Colors: t})
	}
	return out
}

// ---------------------------------------------------------------------------
// VS Code extension themes
// ---------------------------------------------------------------------------

var vscodeANSIKeys = [16]string{"ansiBlack", "ansiRed", "ansiGreen", "ansiYellow", "ansiBlue", "ansiMagenta", "ansiCyan", "ansiWhite",
	"ansiBrightBlack", "ansiBrightRed", "ansiBrightGreen", "ansiBrightYellow", "ansiBrightBlue", "ansiBrightMagenta", "ansiBrightCyan", "ansiBrightWhite"}

// vscodeExtensionRoots: user extensions of VS Code, Insiders, Cursor and
// VSCodium, plus the built-in extensions of the newest installed VS Code.
func vscodeExtensionRoots() []struct{ dir, app string } {
	var roots []struct{ dir, app string }
	home, _ := os.UserHomeDir()
	for _, r := range []struct{ sub, app string }{
		{".vscode", "VS Code"}, {".vscode-insiders", "VS Code Insiders"}, {".cursor", "Cursor"}, {".vscode-oss", "VSCodium"},
	} {
		d := filepath.Join(home, r.sub, "extensions")
		if st, err := os.Stat(d); err == nil && st.IsDir() {
			roots = append(roots, struct{ dir, app string }{d, r.app})
		}
	}
	la := os.Getenv("LOCALAPPDATA")
	for _, inst := range []string{filepath.Join(la, "Programs", "Microsoft VS Code"), `C:\Program Files\Microsoft VS Code`} {
		// Current layout: <install>\<commit>\resources\app\extensions; older: <install>\resources\app\extensions.
		best, bestT := "", time.Time{}
		cands := []string{filepath.Join(inst, "resources", "app", "extensions")}
		if ents, err := os.ReadDir(inst); err == nil {
			for _, e := range ents {
				if e.IsDir() {
					cands = append(cands, filepath.Join(inst, e.Name(), "resources", "app", "extensions"))
				}
			}
		}
		for _, c := range cands {
			if st, err := os.Stat(c); err == nil && st.IsDir() && st.ModTime().After(bestT) {
				best, bestT = c, st.ModTime()
			}
		}
		if best != "" {
			roots = append(roots, struct{ dir, app string }{best, "VS Code (embutido)"})
			break
		}
	}
	return roots
}

type vscodePkg struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Publisher   string `json:"publisher"`
	Version     string `json:"version"`
	Contributes struct {
		Themes []struct {
			ID      string `json:"id"`
			Label   string `json:"label"`
			UITheme string `json:"uiTheme"`
			Path    string `json:"path"`
		} `json:"themes"`
	} `json:"contributes"`
}

func loadVSCodeThemes() []Theme {
	var out []Theme
	seen := map[string]bool{}
	for _, root := range vscodeExtensionRoots() {
		ents, err := os.ReadDir(root.dir)
		if err != nil {
			continue
		}
		// Newest version first so duplicates of older versions are skipped.
		sort.Slice(ents, func(i, j int) bool { return ents[i].Name() > ents[j].Name() })
		for _, e := range ents {
			if !e.IsDir() {
				continue
			}
			extDir := filepath.Join(root.dir, e.Name())
			b, err := os.ReadFile(filepath.Join(extDir, "package.json"))
			if err != nil {
				continue
			}
			var pkg vscodePkg
			if json.Unmarshal(stripJSONC(b), &pkg) != nil || len(pkg.Contributes.Themes) == 0 {
				continue
			}
			nls := loadNLS(extDir)
			extName := resolveNLS(pkg.DisplayName, nls)
			if extName == "" {
				extName = pkg.Name
			}
			for _, ct := range pkg.Contributes.Themes {
				label := resolveNLS(ct.Label, nls)
				if label == "" {
					label = ct.ID
				}
				if label == "" {
					label = strings.TrimSuffix(filepath.Base(ct.Path), filepath.Ext(ct.Path))
				}
				key := strings.ToLower(pkg.Publisher + "." + pkg.Name + "/" + firstNonEmpty(ct.ID, label))
				if seen[key] {
					continue
				}
				seen[key] = true
				colors, err := loadVSCodeColors(filepath.Join(extDir, filepath.FromSlash(ct.Path)), 0)
				if err != nil {
					continue
				}
				dark := !(ct.UITheme == "vs" || ct.UITheme == "hc-light")
				t := vscodeToXterm(colors, dark)
				bgc, _ := parseHex(t.Background)
				out = append(out, Theme{
					ID:     "vscode:" + slugify(key),
					Name:   label,
					Source: "vscode",
					Detail: root.app + " — " + extName,
					Dark:   bgc.lum() < 0.5,
					Colors: t,
					UI:     workbenchUI(colors),
				})
			}
		}
	}
	return out
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

// vscodeToXterm maps VS Code workbench colours to an xterm theme.
// uiKeys: the workbench colours the web interface derivation reads.
var uiKeys = []string{
	"foreground", "descriptionForeground", "focusBorder", "errorForeground",
	"sideBar.background", "sideBar.foreground", "sideBar.border",
	"sideBarSectionHeader.background", "activityBar.background",
	"titleBar.activeBackground", "statusBar.background",
	"tab.activeBackground", "tab.inactiveBackground", "tab.activeForeground", "tab.inactiveForeground", "tab.border",
	"editorGroupHeader.tabsBackground", "editor.background", "editor.foreground",
	"panel.background", "panel.border",
	"list.activeSelectionBackground", "list.activeSelectionForeground", "list.hoverBackground",
	"input.background", "input.border", "input.foreground",
	"button.background", "button.foreground", "button.hoverBackground",
	"menu.background", "menu.foreground", "widget.border", "editorWidget.background",
	"badge.background", "badge.foreground",
}

func workbenchUI(c map[string]string) map[string]string {
	out := map[string]string{}
	for _, k := range uiKeys {
		v := strings.TrimSpace(c[k])
		if _, ok := parseHex(v); ok {
			out[k] = v // may carry alpha (#RRGGBBAA); the UI blends it
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func vscodeToXterm(c map[string]string, dark bool) XtermTheme {
	get := func(keys ...string) string {
		for _, k := range keys {
			if v := normHex(c[k]); v != "" {
				return v
			}
		}
		return ""
	}
	base, defBg, defFg := guiDarkANSI, "#1e1e1e", "#d4d4d4"
	if !dark {
		base, defBg, defFg = guiLightANSI, "#ffffff", "#1f1f1f"
	}
	var ansi [16]string
	for i, k := range vscodeANSIKeys {
		if ansi[i] = get("terminal." + k); ansi[i] == "" {
			ansi[i] = base[i]
		}
	}
	bg := firstNonEmpty(get("terminal.background", "panel.background", "editor.background"), defBg)
	fg := firstNonEmpty(get("terminal.foreground", "editor.foreground", "foreground"), defFg)
	cursor := firstNonEmpty(get("terminalCursor.foreground", "editorCursor.foreground"), fg)
	accent := firstNonEmpty(get("terminalCursor.background"), bg)
	selFgD, selBgD := deriveSelection(fg, bg)
	// Selection may carry alpha in VS Code (#RRGGBBAA): keep it, xterm.js
	// blends it over the cell background like VS Code does.
	selBg := strings.TrimSpace(firstNonEmpty(c["terminal.selectionBackground"], c["editor.selectionBackground"]))
	if _, ok := parseHex(selBg); !ok {
		selBg = selBgD
	}
	selFg := firstNonEmpty(get("terminal.selectionForeground"), "")
	if selBg == selBgD {
		selFg = selFgD
	}
	t := XtermTheme{Background: bg, Foreground: fg, Cursor: cursor, CursorAccent: accent,
		SelectionBackground: selBg, SelectionForeground: selFg}
	t.setANSI(ansi)
	return t
}

// loadVSCodeColors reads a colour theme JSON(C), following "include".
func loadVSCodeColors(path string, depth int) (map[string]string, error) {
	if depth > 5 {
		return nil, fmt.Errorf("include profundo demais")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Include string                     `json:"include"`
		Colors  map[string]json.RawMessage `json:"colors"`
	}
	if err := json.Unmarshal(stripJSONC(b), &doc); err != nil {
		return nil, err
	}
	out := map[string]string{}
	if doc.Include != "" && strings.EqualFold(filepath.Ext(doc.Include), ".json") {
		if inc, err := loadVSCodeColors(filepath.Join(filepath.Dir(path), filepath.FromSlash(doc.Include)), depth+1); err == nil {
			for k, v := range inc {
				out[k] = v
			}
		}
	}
	for k, raw := range doc.Colors {
		var s string
		if json.Unmarshal(raw, &s) == nil {
			out[k] = s
		}
	}
	return out, nil
}

func loadNLS(extDir string) map[string]string {
	b, err := os.ReadFile(filepath.Join(extDir, "package.nls.json"))
	if err != nil {
		return nil
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(stripJSONC(b), &raw) != nil {
		return nil
	}
	m := map[string]string{}
	for k, v := range raw {
		var s string
		if json.Unmarshal(v, &s) == nil {
			m[k] = s
			continue
		}
		var o struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(v, &o) == nil {
			m[k] = o.Message
		}
	}
	return m
}

func resolveNLS(s string, nls map[string]string) string {
	if len(s) > 2 && strings.HasPrefix(s, "%") && strings.HasSuffix(s, "%") {
		if v, ok := nls[s[1:len(s)-1]]; ok {
			return v
		}
		return ""
	}
	return s
}

// stripJSONC removes // and /* */ comments and trailing commas (VS Code
// theme and package files are JSON with comments).
func stripJSONC(b []byte) []byte {
	b = []byte(strings.TrimPrefix(string(b), "\ufeff"))
	out := make([]byte, 0, len(b))
	inStr, esc := false, false
	for i := 0; i < len(b); i++ {
		c := b[i]
		if inStr {
			out = append(out, c)
			if esc {
				esc = false
			} else if c == '\\' {
				esc = true
			} else if c == '"' {
				inStr = false
			}
			continue
		}
		switch {
		case c == '"':
			inStr = true
			out = append(out, c)
		case c == '/' && i+1 < len(b) && b[i+1] == '/':
			for i < len(b) && b[i] != '\n' {
				i++
			}
			if i < len(b) {
				out = append(out, '\n')
			}
		case c == '/' && i+1 < len(b) && b[i+1] == '*':
			i += 2
			for i+1 < len(b) && !(b[i] == '*' && b[i+1] == '/') {
				i++
			}
			i++
		default:
			out = append(out, c)
		}
	}
	// trailing commas: ",<ws>}" or ",<ws>]"
	res := make([]byte, 0, len(out))
	inStr, esc = false, false
	for i := 0; i < len(out); i++ {
		c := out[i]
		if inStr {
			res = append(res, c)
			if esc {
				esc = false
			} else if c == '\\' {
				esc = true
			} else if c == '"' {
				inStr = false
			}
			continue
		}
		if c == '"' {
			inStr = true
		}
		if c == ',' {
			j := i + 1
			for j < len(out) && (out[j] == ' ' || out[j] == '\t' || out[j] == '\r' || out[j] == '\n') {
				j++
			}
			if j < len(out) && (out[j] == '}' || out[j] == ']') {
				continue
			}
		}
		res = append(res, c)
	}
	return res
}

// slugify ports theme_download::slugify.
func slugify(name string) string {
	var sb strings.Builder
	prevDash := false
	for _, r := range strings.ToLower(name) {
		if r < 128 && (r >= 'a' && r <= 'z' || r >= '0' && r <= '9') {
			sb.WriteRune(r)
			prevDash = false
		} else if !prevDash && sb.Len() > 0 {
			sb.WriteByte('-')
			prevDash = true
		}
	}
	return strings.TrimRight(sb.String(), "-")
}

// ---------------------------------------------------------------------------
// catalog cache
// ---------------------------------------------------------------------------

type themeCatalog struct {
	mu     sync.Mutex
	themes []Theme
	json   []byte
	loaded time.Time
}

var themes themeCatalog

// get returns the catalog as JSON; reload forces a rescan of the folders.
func (c *themeCatalog) get(reload bool) ([]byte, []Theme) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.json != nil && !reload {
		return c.json, c.themes
	}
	start := time.Now()
	all := builtinThemes()
	saved := loadSavedThemes(filepath.Join(dataDir(), "themes"))
	sort.Slice(saved, func(i, j int) bool { return strings.ToLower(saved[i].Name) < strings.ToLower(saved[j].Name) })
	all = append(all, saved...)
	vs := loadVSCodeThemes()
	sort.Slice(vs, func(i, j int) bool { return strings.ToLower(vs[i].Name) < strings.ToLower(vs[j].Name) })
	all = append(all, vs...)
	c.themes = all
	c.json, _ = json.Marshal(map[string]any{"themes": all})
	c.loaded = time.Now()
	log.Printf("themes: %d temas (%d Gogh, %d VS Code) em %s", len(all), len(saved), len(vs), time.Since(start).Round(time.Millisecond))
	return c.json, c.themes
}

func (c *themeCatalog) has(id string) (Theme, bool) {
	_, all := c.get(false)
	for _, t := range all {
		if t.ID == id {
			return t, true
		}
	}
	return Theme{}, false
}
