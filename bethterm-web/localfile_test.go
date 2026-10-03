package main

import (
	"bytes"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestValidateLocalPath(t *testing.T) {
	ok := []string{`C:\src\repo\README.md`, `C:/src/repo/README.md`, `\\wsl$\Debian\home\user\notes.txt`, `\\server\share\photo.png`}
	for _, p := range ok {
		if _, err := validateLocalPath(p); err != nil {
			t.Errorf("%q deveria ser válido: %v", p, err)
		}
	}
	bad := map[string]string{
		"":                                     "vazio",
		"README.md":                            "relativo",
		`..\..\Windows\System32\config\SAM`:    "..",
		`C:\src\..\..\Windows\System32`:        "..",
		"file:///C:/src/x.md":                  "esquema",
		"http://example.com/x.png":             "esquema",
		`C:\src\repo\..\..\..\Windows\win.ini`: "..",
	}
	for p, why := range bad {
		if _, err := validateLocalPath(p); err == nil {
			t.Errorf("%q (%s) deveria ser rejeitado", p, why)
		}
	}
}

func TestValidateLocalPathTraversalStaysAbsolute(t *testing.T) {
	// mesmo sem ".." literal, o caminho limpo tem que continuar absoluto
	if _, err := validateLocalPath(`C:x.md`); err == nil {
		t.Fatal("caminho relativo com unidade deveria ser rejeitado")
	}
}

func TestLocalFileCategory(t *testing.T) {
	cases := map[string]string{
		"a.md": "text", "a.MD": "text", "a.markdown": "text", "a.txt": "text", "a.log": "text",
		"a.png": "image", "a.JPG": "image", "a.jpeg": "image", "a.gif": "image", "a.webp": "image", "a.bmp": "image", "a.svg": "image",
		"a.exe": "", "a.go": "", "a": "",
	}
	for name, want := range cases {
		_, got := localFileCategory(name)
		if got != want {
			t.Errorf("localFileCategory(%q) = %q, queria %q", name, got, want)
		}
	}
}

func TestServeLocalFileTextOkAndTruncated(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "notas.md")
	os.WriteFile(p, []byte("# título\nconteúdo curto"), 0o644)
	req := httptest.NewRequest("GET", "/api/local-file?path="+urlEnc(p), nil)
	rr := httptest.NewRecorder()
	serveLocalFile(rr, req)
	if rr.Code != 200 || rr.Body.String() != "# título\nconteúdo curto" || rr.Header().Get("Content-Type") != "text/markdown; charset=utf-8" {
		t.Fatalf("texto: %d %q %q", rr.Code, rr.Body.String(), rr.Header().Get("Content-Type"))
	}
	if rr.Header().Get("X-Truncated") != "" {
		t.Fatal("não deveria truncar um arquivo pequeno")
	}

	big := filepath.Join(dir, "grande.log")
	os.WriteFile(big, bytes.Repeat([]byte("x"), localTextPreviewMax+500), 0o644)
	req2 := httptest.NewRequest("GET", "/api/local-file?path="+urlEnc(big), nil)
	rr2 := httptest.NewRecorder()
	serveLocalFile(rr2, req2)
	if rr2.Code != 200 || rr2.Body.Len() != localTextPreviewMax || rr2.Header().Get("X-Truncated") != "1" {
		t.Fatalf("truncado: %d %d %q", rr2.Code, rr2.Body.Len(), rr2.Header().Get("X-Truncated"))
	}
	if size := rr2.Header().Get("X-File-Size"); size != strconv.Itoa(localTextPreviewMax+500) {
		t.Fatalf("X-File-Size = %q", size)
	}
}

func TestServeLocalFileImageOk(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "foto.png")
	png := []byte{0x89, 'P', 'N', 'G', 1, 2, 3, 4}
	os.WriteFile(p, png, 0o644)
	req := httptest.NewRequest("GET", "/api/local-file?path="+urlEnc(p), nil)
	rr := httptest.NewRecorder()
	serveLocalFile(rr, req)
	if rr.Code != 200 || !bytes.Equal(rr.Body.Bytes(), png) || rr.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("imagem: %d %v %q", rr.Code, rr.Body.Bytes(), rr.Header().Get("Content-Type"))
	}
}

func TestServeLocalFileErrors(t *testing.T) {
	dir := t.TempDir()
	// nao existe
	req := httptest.NewRequest("GET", "/api/local-file?path="+urlEnc(filepath.Join(dir, "sumiu.md")), nil)
	rr := httptest.NewRecorder()
	serveLocalFile(rr, req)
	if rr.Code != 404 || !strings.Contains(rr.Body.String(), "não existe") {
		t.Fatalf("não existe: %d %s", rr.Code, rr.Body)
	}
	// extensao nao permitida
	exe := filepath.Join(dir, "app.exe")
	os.WriteFile(exe, []byte("x"), 0o644)
	req2 := httptest.NewRequest("GET", "/api/local-file?path="+urlEnc(exe), nil)
	rr2 := httptest.NewRecorder()
	serveLocalFile(rr2, req2)
	if rr2.Code != 403 {
		t.Fatalf("extensão: %d %s", rr2.Code, rr2.Body)
	}
	// caminho invalido (relativo)
	req3 := httptest.NewRequest("GET", "/api/local-file?path=notas.md", nil)
	rr3 := httptest.NewRecorder()
	serveLocalFile(rr3, req3)
	if rr3.Code != 400 {
		t.Fatalf("relativo: %d %s", rr3.Code, rr3.Body)
	}
	// pasta em vez de arquivo
	req4 := httptest.NewRequest("GET", "/api/local-file?path="+urlEnc(dir)+"", nil)
	rr4 := httptest.NewRecorder()
	serveLocalFile(rr4, req4)
	if rr4.Code != 400 && rr4.Code != 403 {
		t.Fatalf("pasta: %d %s", rr4.Code, rr4.Body)
	}
	// metodo errado
	req5 := httptest.NewRequest("POST", "/api/local-file", nil)
	rr5 := httptest.NewRecorder()
	serveLocalFile(rr5, req5)
	if rr5.Code != 405 {
		t.Fatalf("método: %d", rr5.Code)
	}
}

func urlEnc(s string) string { return url.QueryEscape(s) }

func TestValidateExternalURL(t *testing.T) {
	ok := []string{"https://example.com", "http://example.com/x?y=1"}
	for _, u := range ok {
		if _, err := validateExternalURL(u); err != nil {
			t.Errorf("%q deveria ser válido: %v", u, err)
		}
	}
	bad := []string{"", "ftp://example.com", "javascript:alert(1)", "file:///C:/x.md", "data:text/html,<script>", "not a url", "https://"}
	for _, u := range bad {
		if _, err := validateExternalURL(u); err == nil {
			t.Errorf("%q deveria ser rejeitado", u)
		}
	}
}

func TestServeOpenLocalFileDefault(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "notas.md")
	os.WriteFile(p, []byte("oi"), 0o644)
	originalLauncher := launchLocalFileDefault
	var launchedPath string
	launchLocalFileDefault = func(path string) error {
		launchedPath = path
		return nil
	}
	t.Cleanup(func() { launchLocalFileDefault = originalLauncher })

	// Caminho valido: verifica o despacho sem abrir um editor durante o teste.
	body := `{"path":` + strconv.Quote(p) + `}`
	req := httptest.NewRequest("POST", "/api/local-file/open-default", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	serveOpenLocalFileDefault(rr, req)
	if rr.Code != 200 {
		t.Fatalf("caminho válido: %d %s", rr.Code, rr.Body)
	}

	// extensao nao permitida
	exe := filepath.Join(dir, "app.exe")
	os.WriteFile(exe, []byte("x"), 0o644)
	if launchedPath != p {
		t.Fatalf("caminho enviado ao editor = %q, queria %q", launchedPath, p)
	}
	body2 := `{"path":` + strconv.Quote(exe) + `}`
	req2 := httptest.NewRequest("POST", "/api/local-file/open-default", strings.NewReader(body2))
	req2.Header.Set("Content-Type", "application/json")
	rr2 := httptest.NewRecorder()
	serveOpenLocalFileDefault(rr2, req2)
	if rr2.Code != 403 {
		t.Fatalf("extensão não permitida: %d %s", rr2.Code, rr2.Body)
	}

	// caminho relativo
	body3 := `{"path":"notas.md"}`
	req3 := httptest.NewRequest("POST", "/api/local-file/open-default", strings.NewReader(body3))
	req3.Header.Set("Content-Type", "application/json")
	rr3 := httptest.NewRecorder()
	serveOpenLocalFileDefault(rr3, req3)
	if rr3.Code != 400 {
		t.Fatalf("relativo: %d %s", rr3.Code, rr3.Body)
	}

	// arquivo que nao existe
	sumiu := filepath.Join(dir, "sumiu.md")
	body4 := `{"path":` + strconv.Quote(sumiu) + `}`
	req4 := httptest.NewRequest("POST", "/api/local-file/open-default", strings.NewReader(body4))
	req4.Header.Set("Content-Type", "application/json")
	rr4 := httptest.NewRecorder()
	serveOpenLocalFileDefault(rr4, req4)
	if rr4.Code != 404 {
		t.Fatalf("não existe: %d %s", rr4.Code, rr4.Body)
	}

	// metodo errado
	req5 := httptest.NewRequest("GET", "/api/local-file/open-default", nil)
	rr5 := httptest.NewRecorder()
	serveOpenLocalFileDefault(rr5, req5)
	if rr5.Code != 400 {
		t.Fatalf("método: %d", rr5.Code)
	}
}

func TestServeOpenLinkRejectsNonHTTP(t *testing.T) {
	body := `{"url":"javascript:alert(1)"}`
	req := httptest.NewRequest("POST", "/api/open-link", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	serveOpenLink(rr, req)
	if rr.Code != 400 {
		t.Fatalf("deveria recusar: %d %s", rr.Code, rr.Body)
	}
}
