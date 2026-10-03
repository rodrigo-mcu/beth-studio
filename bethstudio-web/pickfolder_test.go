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

func TestPickFolderInitial(t *testing.T) {
	dir := t.TempDir()
	if got := pickFolderInitial(dir); !strings.EqualFold(got, dir) {
		t.Fatalf("pasta valida = %q, queria %q", got, dir)
	}
	if got := pickFolderInitial("  " + dir + "  "); !strings.EqualFold(got, dir) {
		t.Fatalf("com espaco = %q", got)
	}
	if pickFolderInitial(filepath.Join(dir, "nao-existe")) != "" {
		t.Fatal("pasta inexistente deveria abrir sem inicial")
	}
	if pickFolderInitial(`C:\foo\..\bar`) != "" {
		t.Fatal("caminho com .. deveria ser recusado")
	}
	file := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if pickFolderInitial(file) != "" {
		t.Fatal("arquivo nao e' pasta")
	}
	if pickFolderInitial("") != "" {
		t.Fatal("vazio")
	}
}

func TestServePickFolder(t *testing.T) {
	old := pickFolderDialog
	t.Cleanup(func() { pickFolderDialog = old })
	dir := t.TempDir()

	var gotInitial string
	pickFolderDialog = func(initial string) (string, bool, error) {
		gotInitial = initial
		return dir, true, nil
	}
	req := httptest.NewRequest("POST", "/api/pick-folder", strings.NewReader(`{"initial":`+strconv.Quote(dir)+`}`))
	rr := httptest.NewRecorder()
	servePickFolder(rr, req)
	if rr.Code != 200 {
		t.Fatalf("pick: %d %s", rr.Code, rr.Body)
	}
	if !strings.EqualFold(gotInitial, dir) {
		t.Fatalf("dialogo recebeu %q", gotInitial)
	}
	var resp struct {
		Picked bool   `json:"picked"`
		Path   string `json:"path"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil || !resp.Picked || !strings.EqualFold(resp.Path, dir) {
		t.Fatalf("resposta %+v %v", resp, err)
	}

	pickFolderDialog = func(initial string) (string, bool, error) {
		if initial != "" {
			t.Errorf("inicial invalida chegou no dialogo: %q", initial)
		}
		return "", false, nil
	}
	req2 := httptest.NewRequest("POST", "/api/pick-folder", strings.NewReader(`{"initial":"Z:\\nao-existe-beth"}`))
	rr2 := httptest.NewRecorder()
	servePickFolder(rr2, req2)
	if rr2.Code != 200 || !strings.Contains(rr2.Body.String(), `"picked":false`) {
		t.Fatalf("cancelar: %d %s", rr2.Code, rr2.Body)
	}

	req3 := httptest.NewRequest("POST", "/api/pick-folder", strings.NewReader(`{`))
	rr3 := httptest.NewRecorder()
	servePickFolder(rr3, req3)
	if rr3.Code != 400 {
		t.Fatalf("json ruim: %d %s", rr3.Code, rr3.Body)
	}
}
