package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestSaveAsTarget(t *testing.T) {
	src := `C:\dados\repo\notes.md`
	ok := map[string]string{
		`C:\Users\u\Documents\notes.md`:      `C:\Users\u\Documents\notes.md`,
		`C:\Users\u\Documents\copia`:         `C:\Users\u\Documents\copia.md`, // sem extensao: a da origem
		`\\wsl.localhost\Debian\home\u\x.md`: `\\wsl.localhost\Debian\home\u\x.md`,
		`D:\out\notes.txt`:                   `D:\out\notes.txt`,
	}
	for in, want := range ok {
		got, err := saveAsTarget(in, src)
		if err != nil || got != want {
			t.Errorf("saveAsTarget(%q) = %q, %v; queria %q", in, got, err, want)
		}
	}
	bad := []string{
		"",
		"notes.md",                     // relativo
		`C:\dados\..\Windows\notes.md`, // traversal
		`C:\Users\u\app.exe`,           // extensao fora da lista
		`C:\Users\u\run.bat`,           // idem
		"file:///C:/x.md",              // esquema
		`c:\DADOS\repo\NOTES.md`,       // o proprio arquivo de origem
	}
	for _, in := range bad {
		if got, err := saveAsTarget(in, src); err == nil {
			t.Errorf("saveAsTarget(%q) deveria falhar, deu %q", in, got)
		}
	}
}

func TestServeSaveAsCopiesRawContent(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "notes.md")
	raw := "# Título\n\ntexto *cru* com [link](https://example.com)\n"
	os.WriteFile(src, []byte(raw), 0o644)
	dest := filepath.Join(dir, "saida", "copia.md")
	os.MkdirAll(filepath.Dir(dest), 0o755)

	old := saveDialog
	t.Cleanup(func() { saveDialog = old })
	var gotName, gotExt string
	saveDialog = func(name, ext string) (string, bool, error) {
		gotName, gotExt = name, ext
		return dest, true, nil
	}
	req := httptest.NewRequest("POST", "/api/local-file/save-as", strings.NewReader(`{"path":`+strconv.Quote(src)+`}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	serveLocalFileSaveAs(rr, req)
	if rr.Code != 200 {
		t.Fatalf("save-as: %d %s", rr.Code, rr.Body)
	}
	if gotName != "notes.md" || gotExt != ".md" {
		t.Errorf("dialogo recebeu nome %q ext %q", gotName, gotExt)
	}
	b, err := os.ReadFile(dest)
	if err != nil || string(b) != raw {
		t.Fatalf("conteúdo salvo = %q, %v", b, err)
	}

	// cancelado: nada escrito, resposta canceled
	saveDialog = func(string, string) (string, bool, error) { return "", false, nil }
	req2 := httptest.NewRequest("POST", "/api/local-file/save-as", strings.NewReader(`{"path":`+strconv.Quote(src)+`}`))
	req2.Header.Set("Content-Type", "application/json")
	rr2 := httptest.NewRecorder()
	serveLocalFileSaveAs(rr2, req2)
	var resp map[string]any
	json.Unmarshal(rr2.Body.Bytes(), &resp)
	if rr2.Code != 200 || resp["canceled"] != true {
		t.Fatalf("cancelado: %d %s", rr2.Code, rr2.Body)
	}

	// destino escolhido com extensao proibida: recusa
	saveDialog = func(string, string) (string, bool, error) { return filepath.Join(dir, "x.exe"), true, nil }
	req3 := httptest.NewRequest("POST", "/api/local-file/save-as", strings.NewReader(`{"path":`+strconv.Quote(src)+`}`))
	req3.Header.Set("Content-Type", "application/json")
	rr3 := httptest.NewRecorder()
	serveLocalFileSaveAs(rr3, req3)
	if rr3.Code != 400 {
		t.Fatalf("destino .exe: %d %s", rr3.Code, rr3.Body)
	}
	if _, err := os.Stat(filepath.Join(dir, "x.exe")); err == nil {
		t.Fatal("não deveria ter escrito x.exe")
	}

	// origem invalida nem abre o dialogo
	called := false
	saveDialog = func(string, string) (string, bool, error) { called = true; return "", false, nil }
	req4 := httptest.NewRequest("POST", "/api/local-file/save-as", strings.NewReader(`{"path":"notes.md"}`))
	req4.Header.Set("Content-Type", "application/json")
	rr4 := httptest.NewRecorder()
	serveLocalFileSaveAs(rr4, req4)
	if rr4.Code != 400 || called {
		t.Fatalf("origem relativa: %d called=%v", rr4.Code, called)
	}
}

func TestServeReveal(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "foto.png")
	os.WriteFile(p, []byte{1}, 0o644)
	old := revealLocal
	t.Cleanup(func() { revealLocal = old })
	var revealed string
	revealLocal = func(path string) error { revealed = path; return nil }

	req := httptest.NewRequest("POST", "/api/local-file/reveal", strings.NewReader(`{"path":`+strconv.Quote(p)+`}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	serveLocalFileReveal(rr, req)
	if rr.Code != 200 || revealed != p {
		t.Fatalf("reveal: %d %s revealed=%q", rr.Code, rr.Body, revealed)
	}
	// nao existe
	revealed = ""
	req2 := httptest.NewRequest("POST", "/api/local-file/reveal", strings.NewReader(`{"path":`+strconv.Quote(filepath.Join(dir, "sumiu.png"))+`}`))
	req2.Header.Set("Content-Type", "application/json")
	rr2 := httptest.NewRecorder()
	serveLocalFileReveal(rr2, req2)
	if rr2.Code != 404 || revealed != "" {
		t.Fatalf("reveal inexistente: %d", rr2.Code)
	}
}

func TestSaveFilter(t *testing.T) {
	f := saveFilter(".md")
	if f[len(f)-1] != 0 || f[len(f)-2] != 0 {
		t.Fatal("filtro precisa terminar com \\0\\0")
	}
}
