package main

// fonts.go — installed Windows font families (like the GUI's
// `list_system_fonts`), each marked monospace or not by reading the font
// file itself: post.isFixedPitch or OS/2 PANOSE proportion = monospaced.
// Files come from the Fonts registry keys (HKLM and HKCU, the latter holds
// per-user installs under %LOCALAPPDATA%\Microsoft\Windows\Fonts).

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type FontFamily struct {
	Family string `json:"family"`
	Mono   bool   `json:"mono"`
}

type FontPreset struct {
	Label  string  `json:"label"`
	Family string  `json:"family"`
	Size   float64 `json:"size,omitempty"`
}

type fontCatalog struct {
	mu   sync.Mutex
	json []byte
}

var fonts fontCatalog

func (c *fontCatalog) get(reload bool) []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.json != nil && !reload {
		return c.json
	}
	start := time.Now()
	fams := listFontFamilies()
	have := map[string]bool{}
	for _, f := range fams {
		have[strings.ToLower(f.Family)] = true
	}
	var presets []FontPreset
	if fam, size := vscodeEditorFont(); fam != "" || size > 0 {
		presets = append(presets, FontPreset{Label: "Fonte do VS Code", Family: fam, Size: size})
	}
	// The GUI's font_presets.rs is still a stub; offer the usual Windows
	// terminal fonts that are actually installed.
	for _, f := range []string{"Cascadia Mono", "Cascadia Code", "Consolas", "JetBrains Mono", "Fira Code", "Lucida Console", "Courier New"} {
		if have[strings.ToLower(f)] {
			presets = append(presets, FontPreset{Label: f, Family: f})
		}
	}
	c.json, _ = json.Marshal(map[string]any{"fonts": fams, "presets": presets})
	n := 0
	for _, f := range fams {
		if f.Mono {
			n++
		}
	}
	log.Printf("fonts: %d famílias (%d monoespaçadas) em %s", len(fams), n, time.Since(start).Round(time.Millisecond))
	return c.json
}

// vscodeEditorFont ports wtinator::vscode_font::read_user_settings.
func vscodeEditorFont() (string, float64) {
	appdata := os.Getenv("APPDATA")
	for _, app := range []string{"Code", "Code - Insiders", "VSCodium", "Cursor"} {
		b, err := os.ReadFile(filepath.Join(appdata, app, "User", "settings.json"))
		if err != nil {
			continue
		}
		var m map[string]any
		if json.Unmarshal(stripJSONC(b), &m) != nil {
			continue
		}
		fam, _ := m["editor.fontFamily"].(string)
		fam = strings.Trim(strings.TrimSpace(strings.Split(fam, ",")[0]), `'"`)
		size, _ := m["editor.fontSize"].(float64)
		return fam, size
	}
	return "", 0
}

