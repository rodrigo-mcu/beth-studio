package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeUIPkg(t *testing.T, dir, manifest, index string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if manifest != "" {
		if err := os.WriteFile(filepath.Join(dir, uiManifestName), []byte(manifest), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if index != "" {
		if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte(index), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func resetUICache() { invalidateUICache() }

func TestCurrentUIOverride(t *testing.T) {
	t.Setenv("BETHSTUDIO_DATA_DIR", t.TempDir())
	resetUICache()

	if u := currentUI(); u.Override || u.Version != "embutida" {
		t.Fatalf("sem pacote deveria usar a embutida: %+v", u)
	}

	dir := uiOverrideDir()
	writeUIPkg(t, dir, `{"version":"2026.10.08-1","requires_api":1}`, "<html>nova</html>")
	resetUICache()
	u := currentUI()
	if !u.Override || u.Version != "2026.10.08-1" {
		t.Fatalf("pacote válido deveria ser usado: %+v", u)
	}
	b, err := fs.ReadFile(u.FS, "index.html")
	if err != nil || !strings.Contains(string(b), "nova") {
		t.Fatalf("index do override: %v %q", err, b)
	}
}

func TestCurrentUIFallbacks(t *testing.T) {
	cases := []struct {
		name, manifest, index, reason string
	}{
		{"manifesto inválido", `{nao json`, "<html></html>", "inválido"},
		{"sem versão", `{"requires_api":1}`, "<html></html>", "inválido"},
		{"api nova demais", `{"version":"x","requires_api":999}`, "<html></html>", "Studio mais novo"},
		{"sem index.html", `{"version":"x","requires_api":1}`, "", "index.html"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("BETHSTUDIO_DATA_DIR", t.TempDir())
			writeUIPkg(t, uiOverrideDir(), c.manifest, c.index)
			resetUICache()
			u := currentUI()
			if u.Override || u.Version != "embutida" || !strings.Contains(u.Reason, c.reason) {
				t.Fatalf("esperava fallback com %q, veio %+v", c.reason, u)
			}
			if _, err := fs.Stat(u.FS, "index.html"); err != nil {
				t.Fatalf("a embutida precisa servir index.html: %v", err)
			}
		})
	}
}

func TestCurrentUIManifestBOM(t *testing.T) {
	t.Setenv("BETHSTUDIO_DATA_DIR", t.TempDir())
	writeUIPkg(t, uiOverrideDir(), "\uFEFF"+`{"version":"2026.10.14-1","requires_api":1}`, "<html>bom</html>")
	resetUICache()
	u := currentUI()
	if !u.Override || u.Version != "2026.10.14-1" {
		t.Fatalf("manifesto com BOM deveria valer: %+v", u)
	}
}
