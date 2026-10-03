package main

// fonts.go — installed Windows font families (like the GUI's
// `list_system_fonts`), each marked monospace or not by reading the font
// file itself: post.isFixedPitch or OS/2 PANOSE proportion = monospaced.
// Files come from the Fonts registry keys (HKLM and HKCU, the latter holds
// per-user installs under %LOCALAPPDATA%\Microsoft\Windows\Fonts).

import (
	"encoding/binary"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"golang.org/x/sys/windows/registry"
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

func listFontFamilies() []FontFamily {
	winFonts := filepath.Join(os.Getenv("WINDIR"), "Fonts")
	files := map[string]bool{}
	for _, root := range []registry.Key{registry.LOCAL_MACHINE, registry.CURRENT_USER} {
		k, err := registry.OpenKey(root, `SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts`, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		names, _ := k.ReadValueNames(-1)
		for _, n := range names {
			v, _, err := k.GetStringValue(n)
			if err != nil || v == "" {
				continue
			}
			if !filepath.IsAbs(v) {
				v = filepath.Join(winFonts, v)
			}
			switch strings.ToLower(filepath.Ext(v)) {
			case ".ttf", ".otf", ".ttc", ".otc":
				files[v] = true
			}
		}
		k.Close()
	}
	mono := map[string]bool{}
	display := map[string]string{}
	for f := range files {
		for _, face := range readFontFaces(f) {
			if face.family == "" || strings.HasPrefix(face.family, "@") {
				continue
			}
			key := strings.ToLower(face.family)
			if _, ok := display[key]; !ok {
				display[key] = face.family
			}
			mono[key] = mono[key] || face.mono
		}
	}
	out := make([]FontFamily, 0, len(display))
	for k, fam := range display {
		out = append(out, FontFamily{Family: fam, Mono: mono[k]})
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Family) < strings.ToLower(out[j].Family) })
	return out
}

type fontFace struct {
	family string
	mono   bool
}

// readFontFaces reads the sfnt table directory of a .ttf/.otf or every face
// of a .ttc collection.
func readFontFaces(path string) []fontFace {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	rd := func(off int64, n int) []byte {
		b := make([]byte, n)
		if _, err := f.ReadAt(b, off); err != nil {
			return nil
		}
		return b
	}
	hdr := rd(0, 12)
	if hdr == nil {
		return nil
	}
	var offsets []int64
	if string(hdr[:4]) == "ttcf" {
		n := binary.BigEndian.Uint32(hdr[8:12])
		if n > 64 {
			n = 64
		}
		tbl := rd(12, int(n)*4)
		for i := 0; tbl != nil && i < int(n); i++ {
			offsets = append(offsets, int64(binary.BigEndian.Uint32(tbl[i*4:])))
		}
	} else {
		offsets = []int64{0}
	}
	var faces []fontFace
	for _, off := range offsets {
		h := rd(off, 12)
		if h == nil {
			continue
		}
		numTables := int(binary.BigEndian.Uint16(h[4:6]))
		dir := rd(off+12, numTables*16)
		if dir == nil {
			continue
		}
		tables := map[string][2]uint32{}
		for i := 0; i < numTables; i++ {
			r := dir[i*16:]
			tables[string(r[:4])] = [2]uint32{binary.BigEndian.Uint32(r[8:12]), binary.BigEndian.Uint32(r[12:16])}
		}
		var face fontFace
		if t, ok := tables["name"]; ok && t[1] < 1<<20 {
			face.family = parseNameTable(rd(int64(t[0]), int(t[1])))
		}
		if t, ok := tables["post"]; ok && t[1] >= 16 {
			if b := rd(int64(t[0]), 16); b != nil && binary.BigEndian.Uint32(b[12:16]) != 0 {
				face.mono = true
			}
		}
		if t, ok := tables["OS/2"]; ok && t[1] >= 42 {
			// panose at offset 32: bFamilyType(0)=2 (Latin text), bProportion(3)=9 (monospaced)
			if b := rd(int64(t[0])+32, 10); b != nil && b[0] == 2 && b[3] == 9 {
				face.mono = true
			}
		}
		faces = append(faces, face)
	}
	return faces
}

// parseNameTable returns the typographic family (nameID 16) or the family
// (nameID 1), preferring Windows/Unicode English strings.
func parseNameTable(b []byte) string {
	if len(b) < 6 {
		return ""
	}
	count := int(binary.BigEndian.Uint16(b[2:4]))
	strOff := int(binary.BigEndian.Uint16(b[4:6]))
	best := map[uint16]string{}
	bestScore := map[uint16]int{}
	for i := 0; i < count; i++ {
		r := 6 + i*12
		if r+12 > len(b) {
			break
		}
		plat := binary.BigEndian.Uint16(b[r:])
		enc := binary.BigEndian.Uint16(b[r+2:])
		lang := binary.BigEndian.Uint16(b[r+4:])
		id := binary.BigEndian.Uint16(b[r+6:])
		ln := int(binary.BigEndian.Uint16(b[r+8:]))
		off := int(binary.BigEndian.Uint16(b[r+10:]))
		if id != 1 && id != 16 {
			continue
		}
		s0, s1 := strOff+off, strOff+off+ln
		if s1 > len(b) || s0 < 0 {
			continue
		}
		raw := b[s0:s1]
		var s string
		score := 0
		switch {
		case plat == 3 && (enc == 1 || enc == 10 || enc == 0):
			u := make([]uint16, len(raw)/2)
			for j := range u {
				u[j] = binary.BigEndian.Uint16(raw[j*2:])
			}
			s = string(utf16.Decode(u))
			score = 2
			if lang == 0x409 {
				score = 3
			}
		case plat == 0:
			u := make([]uint16, len(raw)/2)
			for j := range u {
				u[j] = binary.BigEndian.Uint16(raw[j*2:])
			}
			s = string(utf16.Decode(u))
			score = 1
		case plat == 1 && enc == 0:
			s = string(raw) // Mac Roman ~ ASCII for family names
			score = 1
		default:
			continue
		}
		s = strings.TrimSpace(s)
		if s != "" && score > bestScore[id] {
			best[id], bestScore[id] = s, score
		}
	}
	if s := best[16]; s != "" {
		return s
	}
	return best[1]
}
