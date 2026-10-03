package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestUIThemePersistenceAndClearPanes(t *testing.T) {
	dir := t.TempDir()
	// Arquivo da versao anterior (sem ui_theme): continua valendo, com
	// "Escuro" como padrao.
	old := `{"version":2,"default":{"theme":"vscode_dark"},"panes":{"28":{"theme":"1984-dark","host_id":"H"},"31":{"font_size":20,"host_id":"H"}},"font_favorites":[],"theme_favorites":[]}`
	if err := os.WriteFile(filepath.Join(dir, webSettingsFile), []byte(old), 0o644); err != nil {
		t.Fatal(err)
	}
	themes.mu.Lock()
	themes.themes = builtinThemes()
	themes.json = []byte("{}")
	themes.mu.Unlock()

	st := &settingsStore{}
	st.load(dir)
	if s := st.snapshot(); s.UITheme.Mode != "dark" {
		t.Fatalf("default ui mode = %q", s.UITheme.Mode)
	}
	if _, err := st.setUITheme(UITheme{Mode: "cor-maluca"}); err == nil {
		t.Fatal("invalid mode accepted")
	}
	if _, err := st.setUITheme(UITheme{Mode: "theme", ThemeID: "nao-existe"}); err == nil {
		t.Fatal("unknown theme accepted")
	}
	if _, err := st.setUITheme(UITheme{Mode: "theme", ThemeID: "windows_terminal_dark"}); err != nil {
		t.Fatal(err)
	}
	if s, err := st.setUITheme(UITheme{Mode: "follow", ThemeID: "ignorado"}); err != nil || s.UITheme.ThemeID != "" {
		t.Fatalf("follow: %v %+v", err, s.UITheme)
	}
	if _, err := st.setUITheme(UITheme{Mode: "theme", ThemeID: "vscode_light"}); err != nil {
		t.Fatal(err)
	}
	_, n, err := st.clearPanes()
	if err != nil || n != 2 {
		t.Fatalf("clearPanes = %d, %v", n, err)
	}

	st2 := &settingsStore{}
	st2.load(dir)
	s := st2.snapshot()
	if s.UITheme.Mode != "theme" || s.UITheme.ThemeID != "vscode_light" {
		t.Fatalf("reload ui = %+v", s.UITheme)
	}
	if len(st2.s.Panes) != 0 || st2.s.Default.Theme != "vscode_dark" {
		t.Fatalf("reload panes/default = %+v / %+v", st2.s.Panes, st2.s.Default)
	}
}

func TestWorkbenchUIKeys(t *testing.T) {
	ui := workbenchUI(map[string]string{
		"sideBar.background": "#181818", "focusBorder": "#0078D4", "list.hoverBackground": "#2a2d2e80",
		"editor.background": "nao-e-cor", "someOther.key": "#ffffff",
	})
	if ui["sideBar.background"] != "#181818" || ui["list.hoverBackground"] != "#2a2d2e80" {
		t.Fatalf("ui = %v", ui)
	}
	if _, ok := ui["editor.background"]; ok {
		t.Fatal("invalid colour kept")
	}
	if _, ok := ui["someOther.key"]; ok {
		t.Fatal("unrelated key kept")
	}
	if workbenchUI(map[string]string{}) != nil {
		t.Fatal("empty should be nil")
	}
}

func TestSidebarPrefs(t *testing.T) {
	dir := t.TempDir()
	st := &settingsStore{}
	st.load(dir) // arquivo inexistente: padrao
	if s := st.snapshot(); s.Sidebar.Collapsed || s.Sidebar.Width != defaultSidebarWidth {
		t.Fatalf("default sidebar = %+v", s.Sidebar)
	}
	if s, _ := st.setSidebar(SidebarPrefs{Width: 50}); s.Sidebar.Width != minSidebarWidth {
		t.Fatalf("min clamp = %d", s.Sidebar.Width)
	}
	if s, _ := st.setSidebar(SidebarPrefs{Width: 5000}); s.Sidebar.Width != maxSidebarWidth {
		t.Fatalf("max clamp = %d", s.Sidebar.Width)
	}
	if _, err := st.setSidebar(SidebarPrefs{Collapsed: true, Width: 333}); err != nil {
		t.Fatal(err)
	}
	st2 := &settingsStore{}
	st2.load(dir)
	if s := st2.snapshot(); !s.Sidebar.Collapsed || s.Sidebar.Width != 333 {
		t.Fatalf("reload sidebar = %+v", s.Sidebar)
	}
}

func TestUIThemeLegacyModesMigrate(t *testing.T) {
	dir := t.TempDir()
	st := &settingsStore{}
	st.load(dir)
	st.s.UITheme = &UITheme{Mode: "old-dark"} // arquivo de versao anterior (modo com prefixo)
	if s := st.snapshot(); s.UITheme.Mode != "dark" {
		t.Fatalf("legacy = %q", s.UITheme.Mode)
	}
	if s, err := st.setUITheme(UITheme{Mode: "old-dark"}); err != nil || s.UITheme.Mode != "dark" {
		t.Fatalf("set legacy = %v %+v", err, s.UITheme)
	}
	if s, err := st.setUITheme(UITheme{Mode: "old-blue"}); err != nil || s.UITheme.Mode != "navy" {
		t.Fatalf("old-blue = %v %+v", err, s.UITheme)
	}
}

func TestFontBoldAndGUIDefaults(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, guiDefaultFile), []byte(`{"theme":"vscode_light","font_family":null,"font_scale":0.83,"font_bold":true,"font_italic":false}`), 0o644)
	themes.mu.Lock()
	themes.themes = builtinThemes()
	themes.json = []byte("{}")
	themes.mu.Unlock()
	st := &settingsStore{}
	st.load(dir)
	s := st.snapshot()
	if !s.GUIDefaultBold || s.GUIDefaultFont != "" {
		t.Fatalf("gui defaults: bold=%v font=%q", s.GUIDefaultBold, s.GUIDefaultFont)
	}
	st.live = map[int]paneMeta{5: {"t", "c"}}
	f := false
	if _, err := st.setPane(5, Appearance{FontBold: &f}); err != nil {
		t.Fatal(err)
	}
	st2 := &settingsStore{}
	st2.load(dir)
	if p := st2.s.Panes["5"]; p == nil || p.FontBold == nil || *p.FontBold {
		t.Fatalf("pane bold = %+v", p)
	}
}
