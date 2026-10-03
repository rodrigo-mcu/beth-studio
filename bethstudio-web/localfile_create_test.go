package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func createReq(t *testing.T, path, content string) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(map[string]string{"path": path, "content": content})
	r := httptest.NewRequest(http.MethodPost, "/api/local-file/create", strings.NewReader(string(b)))
	r.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	serveLocalFileCreate(rec, r)
	return rec
}

func TestLocalFileCreate(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "notas.md")
	if rec := createReq(t, p, "# oi\n"); rec.Code != http.StatusOK {
		t.Fatalf("criar: %d %s", rec.Code, rec.Body.String())
	}
	if b, _ := os.ReadFile(p); string(b) != "# oi\n" {
		t.Fatalf("conteúdo: %q", b)
	}
	// nunca sobrescreve
	if rec := createReq(t, p, "outro"); rec.Code != http.StatusConflict {
		t.Fatalf("existente: %d", rec.Code)
	}
	if b, _ := os.ReadFile(p); string(b) != "# oi\n" {
		t.Fatal("sobrescreveu")
	}
	for _, c := range []struct {
		path string
		code int
	}{
		{filepath.Join(dir, "x.exe"), http.StatusBadRequest},
		{filepath.Join(dir, "CON.txt"), http.StatusBadRequest},
		{filepath.Join(dir, "a?b.txt"), http.StatusBadRequest},
		{filepath.Join(dir, " comeca.txt"), http.StatusBadRequest},
		{filepath.Join(dir, "nao-existe", "a.txt"), http.StatusNotFound},
		{dir + `\..\fora.txt`, http.StatusBadRequest},
		{"relativo.txt", http.StatusBadRequest},
	} {
		if rec := createReq(t, c.path, ""); rec.Code != c.code {
			t.Fatalf("%s: %d, queria %d (%s)", c.path, rec.Code, c.code, rec.Body.String())
		}
	}
}
