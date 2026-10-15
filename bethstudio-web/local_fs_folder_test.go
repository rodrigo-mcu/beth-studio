package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOpenFolderInExplorer(t *testing.T) {
	var opened string
	old := openFolderLocal
	openFolderLocal = func(d string) error { opened = d; return nil }
	defer func() { openFolderLocal = old }()

	dir := t.TempDir()
	if err := openFolderInExplorer(dir); err != nil || opened != dir {
		t.Fatalf("pasta existente: err=%v opened=%q", err, opened)
	}
	opened = ""
	if err := openFolderInExplorer(filepath.Join(dir, "nao-existe")); err == nil || opened != "" {
		t.Fatalf("pasta inexistente deve falhar sem abrir: err=%v opened=%q", err, opened)
	}
	f := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(f, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := openFolderInExplorer(f); err == nil || opened != "" {
		t.Fatalf("arquivo não é pasta: err=%v opened=%q", err, opened)
	}
	// "~" abre a pasta do usuário
	home, _ := os.UserHomeDir()
	if err := openFolderInExplorer("~"); err != nil || opened != filepath.Clean(home) {
		t.Fatalf("~: err=%v opened=%q home=%q", err, opened, home)
	}
}
