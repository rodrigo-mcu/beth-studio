package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func postWrite(t *testing.T, body map[string]any) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/api/local-file/write", strings.NewReader(string(b)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	serveLocalFileWrite(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestWriteSavesAndDetectsConflict(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "notas.md")
	os.WriteFile(p, []byte("antes\r\n"), 0o644)

	// a leitura devolve o mtime
	req := httptest.NewRequest("GET", "/api/local-file?path="+urlEnc(p), nil)
	rec := httptest.NewRecorder()
	serveLocalFile(rec, req)
	mt := rec.Header().Get("X-File-Mtime")
	if mt == "" {
		t.Fatal("GET sem X-File-Mtime")
	}

	code, out := postWrite(t, map[string]any{"path": p, "content": "depois\r\n", "mtime": mt})
	if code != 200 {
		t.Fatalf("write = %d %v", code, out)
	}
	if got, _ := os.ReadFile(p); string(got) != "depois\r\n" {
		t.Fatalf("conteúdo = %q", got)
	}
	newMt, _ := out["mtime"].(string)
	if newMt == "" {
		t.Fatal("resposta sem mtime novo")
	}

	// alguém mexeu no arquivo: o mtime antigo não vale mais
	later := time.Now().Add(5 * time.Second)
	os.WriteFile(p, []byte("do agente\n"), 0o644)
	os.Chtimes(p, later, later)
	code, out = postWrite(t, map[string]any{"path": p, "content": "meu texto", "mtime": newMt})
	if code != 409 || out["conflict"] != true {
		t.Fatalf("conflito esperado, veio %d %v", code, out)
	}
	if got, _ := os.ReadFile(p); string(got) != "do agente\n" {
		t.Fatalf("conflito não pode gravar: %q", got)
	}
	code, _ = postWrite(t, map[string]any{"path": p, "content": "meu texto", "mtime": newMt, "force": true})
	if got, _ := os.ReadFile(p); code != 200 || string(got) != "meu texto" {
		t.Fatalf("force: %d %q", code, got)
	}
}

func TestWriteRejects(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "x.bat")
	os.WriteFile(exe, []byte("echo"), 0o644)
	cases := []map[string]any{
		{"path": exe, "content": "del *"},                             // extensão fora da lista
		{"path": "notas.md", "content": "x"},                          // relativo
		{"path": filepath.Join(dir, "..", "y.md"), "content": "x"},    // traversal
		{"path": filepath.Join(dir, "nao-existe.md"), "content": "x"}, // não cria arquivo novo
		{"path": filepath.Join(dir, "img.png"), "content": "x"},       // imagem não é editável
	}
	for _, c := range cases {
		if code, _ := postWrite(t, c); code == 200 {
			t.Errorf("deveria recusar %v", c["path"])
		}
	}
	if got, _ := os.ReadFile(exe); string(got) != "echo" {
		t.Fatal(".bat foi alterado")
	}
	if _, err := os.Stat(filepath.Join(dir, "nao-existe.md")); err == nil {
		t.Fatal("criou arquivo novo")
	}
}

func TestOpenDialogValidatesChoice(t *testing.T) {
	dir := t.TempDir()
	old := openDialog
	t.Cleanup(func() { openDialog = old })
	var gotInitial string
	pick := filepath.Join(dir, "leia.md")
	openDialog = func(initial string) (string, bool, error) { gotInitial = initial; return pick, true, nil }
	call := func() (int, map[string]any) {
		req := httptest.NewRequest("POST", "/api/local-file/open-dialog", strings.NewReader(`{"initial":`+strconv.Quote(dir)+`}`))
		rec := httptest.NewRecorder()
		serveLocalFileOpenDialog(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	code, out := call()
	if code != 200 || out["path"] != pick || gotInitial != dir {
		t.Fatalf("abrir: %d %v initial=%q", code, out, gotInitial)
	}
	pick = filepath.Join(dir, "app.exe")
	if code, _ := call(); code == 200 {
		t.Fatal("aceitou .exe")
	}
	openDialog = func(string) (string, bool, error) { return "", false, nil }
	if code, out := call(); code != 200 || out["canceled"] != true {
		t.Fatalf("cancelar: %d %v", code, out)
	}
}
