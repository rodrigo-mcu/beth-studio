package main

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/image/bmp"
)

func TestWSLPathAndMarkdownLikeGUI(t *testing.T) {
	cases := map[string]string{
		`C:\tmp\bethstudio\clipboard-images\x.png`: "/mnt/c/tmp/bethstudio/clipboard-images/x.png",
		`D:/`:                                    "/mnt/d",
		`C:\`:                                    "/mnt/c",
		`\\server\share\a`:                       "//server/share/a",
	}
	for in, want := range cases {
		if got := windowsPathToWSLMount(in); got != want {
			t.Errorf("%q -> %q, want %q", in, got, want)
		}
	}
	p := `C:\tmp\bethstudio\clipboard-images\clipboard-3x2-1.png`
	if got := markdownImageLink(p, false); got != "![image](C:/tmp/bethstudio/clipboard-images/clipboard-3x2-1.png)" {
		t.Fatalf("windows link %q", got)
	}
	if got := markdownImageLink(p, true); got != "![image](/mnt/c/tmp/bethstudio/clipboard-images/clipboard-3x2-1.png)" {
		t.Fatalf("wsl link %q", got)
	}
	if !cwdLooksWSL("file://pc/mnt/data/x/") || !cwdLooksWSL("file://pc/home/user") ||
		cwdLooksWSL("file:///C:/src/repo/") || cwdLooksWSL("") {
		t.Fatal("cwdLooksWSL")
	}
}

type pasteRecorder struct {
	mu   bytes.Buffer
	reqs []map[string]any
}

func (p *pasteRecorder) Write(b []byte) (int, error) {
	var m map[string]any
	_ = json.Unmarshal(bytes.TrimSpace(b), &m)
	p.reqs = append(p.reqs, m)
	return len(b), nil
}
func (p *pasteRecorder) Close() error { return nil }

func pasteServer(t *testing.T, readOnly bool) (*server, *pasteRecorder, string) {
	t.Helper()
	dir := t.TempDir()
	oldDir, oldNow := imageDir, nowMillis
	imageDir = func() string { return dir }
	nowMillis = func() int64 { return 1790000000123 }
	t.Cleanup(func() { imageDir, nowMillis = oldDir, oldNow })
	h := newHub(readOnly)
	br := newBridge("fake.exe", h)
	h.bridge = br
	rec := &pasteRecorder{}
	br.stdin = rec
	h.lastList = []byte(`{"ev":"list","panes":[{"pane_id":1,"cwd":"file:///C:/src/repo/"},{"pane_id":2,"cwd":"file://pc/mnt/data/src/"}]}`)
	return newServer("tok", 5555, "", h).(*server), rec, dir
}

func post(s *server, path, ctype string, body []byte) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "http://127.0.0.1:5555"+path, bytes.NewReader(body))
	req.Host = "127.0.0.1:5555"
	req.Header.Set(tokenHeader, "tok")
	req.Header.Set("Content-Type", ctype)
	rr := httptest.NewRecorder()
	s.ServeHTTP(rr, req)
	return rr
}

func testImage(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x * 40), uint8(y * 60), 200, 255})
		}
	}
	return img
}

func TestPasteImageSavesPNGAndPastesMarkdown(t *testing.T) {
	s, rec, dir := pasteServer(t, false)
	var jp bytes.Buffer
	_ = jpeg.Encode(&jp, testImage(3, 2), nil)
	rr := post(s, "/api/paste-image?pane_id=1", "image/jpeg", jp.Bytes())
	if rr.Code != 200 {
		t.Fatalf("jpeg: %d %s", rr.Code, rr.Body)
	}
	want := filepath.Join(dir, "clipboard-3x2-1790000000123.png")
	f, err := os.Open(want)
	if err != nil {
		t.Fatalf("saved file: %v", err)
	}
	img, err := png.Decode(f) // re-encoded as PNG
	f.Close()
	if err != nil || img.Bounds().Dx() != 3 || img.Bounds().Dy() != 2 {
		t.Fatalf("png: %v %v", err, img)
	}
	last := rec.reqs[len(rec.reqs)-1]
	wantText := "![image](" + strings.ReplaceAll(want, `\`, "/") + ")"
	if last["op"] != "paste" || last["pane_id"].(float64) != 1 || last["data"] != wantText {
		t.Fatalf("paste sent = %v, want %q", last, wantText)
	}
	// pane 2 has a Linux cwd => WSL path
	var bm bytes.Buffer
	_ = bmp.Encode(&bm, testImage(4, 4))
	rr = post(s, "/api/paste-image?pane_id=2", "image/bmp", bm.Bytes())
	var out struct {
		Text string `json:"text"`
		WSL  bool   `json:"wsl"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	if rr.Code != 200 || !out.WSL || !strings.HasPrefix(out.Text, "![image](/mnt/") {
		t.Fatalf("wsl paste: %d %s", rr.Code, rr.Body)
	}
	// explicit override wsl=0
	var pn bytes.Buffer
	_ = png.Encode(&pn, testImage(2, 2))
	rr = post(s, "/api/paste-image?pane_id=2&wsl=0", "image/png", pn.Bytes())
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	if out.WSL {
		t.Fatal("wsl=0 ignored")
	}
}

func TestPasteRefusals(t *testing.T) {
	s, rec, _ := pasteServer(t, false)
	var pn bytes.Buffer
	_ = png.Encode(&pn, testImage(2, 2))
	if rr := post(s, "/api/paste-image?pane_id=1", "image/svg+xml", []byte("<svg/>")); rr.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("svg: %d", rr.Code)
	}
	if rr := post(s, "/api/paste-image?pane_id=1", "text/plain", pn.Bytes()); rr.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("text/plain: %d", rr.Code)
	}
	if rr := post(s, "/api/paste-image?pane_id=-1", "image/png", pn.Bytes()); rr.Code != http.StatusBadRequest {
		t.Fatalf("pane -1: %d", rr.Code)
	}
	if rr := post(s, "/api/paste-image?pane_id=1", "image/png", []byte("nao e png")); rr.Code != http.StatusBadRequest {
		t.Fatalf("garbage: %d", rr.Code)
	}
	big := make([]byte, maxPasteBytes+10)
	if rr := post(s, "/api/paste-file?pane_id=1", "application/octet-stream", big); rr.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("too big: %d", rr.Code)
	}
	if rr := post(s, "/api/paste-file?pane_id=1", "application/x-www-form-urlencoded", []byte("a=b")); rr.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("form post: %d", rr.Code)
	}
	if len(rec.reqs) != 0 {
		t.Fatalf("refused requests reached the bridge: %v", rec.reqs)
	}
	ro, rec2, _ := pasteServer(t, true)
	if rr := post(ro, "/api/paste-image?pane_id=1", "image/png", pn.Bytes()); rr.Code != http.StatusForbidden || len(rec2.reqs) != 0 {
		t.Fatalf("read-only: %d", rr.Code)
	}
}

func TestPasteClipboardAnyFile(t *testing.T) {
	s, rec, dir := pasteServer(t, false)
	src := t.TempDir()
	pdf := filepath.Join(src, "relatorio final.pdf")
	video := filepath.Join(src, "aula.mp4")
	photo := filepath.Join(src, "foto.png")
	if err := os.WriteFile(pdf, []byte("%PDF-1.4"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(video, []byte("mp4-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(photo, []byte("png-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	folder := filepath.Join(src, "pasta")
	if err := os.Mkdir(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	old := clipboardFilePaths
	clipboardFilePaths = func() ([]string, error) { return []string{pdf, video, photo, folder}, nil }
	t.Cleanup(func() { clipboardFilePaths = old })

	rr := post(s, "/api/paste-clipboard?pane_id=2", "application/json", []byte("{}"))
	if rr.Code != 200 {
		t.Fatalf("%d %s", rr.Code, rr.Body)
	}
	var out struct {
		Paths []string `json:"paths"`
		Text  string   `json:"text"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Paths) != 4 {
		t.Fatalf("paths: %#v", out.Paths)
	}
	for _, name := range []string{"relatorio final.pdf", "aula.mp4"} {
		got, err := os.ReadFile(filepath.Join(dir, "file-1790000000123-"+name))
		if err != nil {
			t.Fatalf("copia %s: %v", name, err)
		}
		if name == "relatorio final.pdf" && string(got) != "%PDF-1.4" {
			t.Fatalf("pdf bytes %q", got)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "file-1790000000123-foto.png")); err != nil {
		t.Fatal(err)
	}
	// pasta nao e' copiada; o caminho original (WSL) entra no texto
	if !strings.Contains(out.Text, "/mnt/") || !strings.Contains(out.Text, "pasta") {
		t.Fatalf("texto: %q", out.Text)
	}
	if !strings.Contains(out.Text, "![image](") || !strings.Contains(out.Text, "aula.mp4") {
		t.Fatalf("imagem e video: %q", out.Text)
	}
	if len(rec.reqs) != 1 || rec.reqs[0]["data"] != out.Text {
		t.Fatalf("bridge: %#v", rec.reqs)
	}

	clipboardFilePaths = func() ([]string, error) { return nil, nil }
	rr = post(s, "/api/paste-clipboard?pane_id=1", "application/json", []byte("{}"))
	if rr.Code != 200 || !strings.Contains(rr.Body.String(), `"empty":true`) {
		t.Fatalf("vazio: %d %s", rr.Code, rr.Body)
	}
	if len(rec.reqs) != 1 {
		t.Fatal("vazio nao pode colar")
	}
}

func TestPasteFileCopy(t *testing.T) {
	s, rec, dir := pasteServer(t, false)
	rr := post(s, "/api/paste-file?pane_id=1&name="+"relat%C3%B3rio%20final%3F.pdf", "application/octet-stream", []byte("%PDF-1.4"))
	if rr.Code != 200 {
		t.Fatalf("%d %s", rr.Code, rr.Body)
	}
	want := filepath.Join(dir, "file-1790000000123-relat_rio final_.pdf")
	if b, err := os.ReadFile(want); err != nil || string(b) != "%PDF-1.4" {
		t.Fatalf("copy: %v", err)
	}
	if got := rec.reqs[len(rec.reqs)-1]["data"]; got != `"`+want+`"` {
		t.Fatalf("pasted %q", got)
	}
	// path traversal in the name is neutralised
	rr = post(s, "/api/paste-file?pane_id=2&name=..%2F..%2Fevil.txt", "application/octet-stream", []byte("x"))
	var out struct{ Path, Text string }
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	if filepath.Dir(out.Path) != dir || !strings.HasPrefix(out.Text, "/mnt/") {
		t.Fatalf("traversal/wsl: %+v", out)
	}
}

func TestPasteTextSavesFileAndReturnsInstruction(t *testing.T) {
	s, rec, _ := pasteServer(t, false)
	tdir := t.TempDir()
	oldT := textDir
	textDir = func() string { return tdir }
	t.Cleanup(func() { textDir = oldT })

	old := filepath.Join(tdir, "fala-1.txt")
	if err := os.WriteFile(old, []byte("velho"), 0o644); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-textFileKeep - time.Hour)
	_ = os.Chtimes(old, past, past)

	long := strings.Repeat("texto longo ", 1000)
	body, _ := json.Marshal(map[string]any{"pane_id": 1, "text": long})
	rr := post(s, "/api/paste-text", "application/json", body)
	if rr.Code != 200 {
		t.Fatalf("%d %s", rr.Code, rr.Body)
	}
	var out struct{ Path, Text string }
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	if b, err := os.ReadFile(out.Path); err != nil || string(b) != long {
		t.Fatalf("arquivo: %v", err)
	}
	if !strings.Contains(out.Text, out.Path) || len(out.Text) > 400 {
		t.Fatalf("instrução: %q", out.Text)
	}
	if _, err := os.Stat(old); err == nil {
		t.Fatal("arquivo antigo devia ter sido apagado")
	}
	if len(rec.reqs) != 0 {
		t.Fatal("o endpoint não cola; quem cola é a página")
	}

	// pane WSL: caminho vira /mnt/...
	body, _ = json.Marshal(map[string]any{"pane_id": 2, "text": "oi"})
	rr = post(s, "/api/paste-text", "application/json", body)
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	if !strings.Contains(out.Text, "/mnt/") {
		t.Fatalf("wsl: %q", out.Text)
	}

	body, _ = json.Marshal(map[string]any{"pane_id": 1, "text": "  "})
	if rr := post(s, "/api/paste-text", "application/json", body); rr.Code != http.StatusBadRequest {
		t.Fatalf("vazio: %d", rr.Code)
	}
	ro, _, _ := pasteServer(t, true)
	if rr := post(ro, "/api/paste-text", "application/json", body); rr.Code != http.StatusForbidden {
		t.Fatalf("somente leitura: %d", rr.Code)
	}
}

// Terminal WSL aberto pelo Studio: o host lista o cwd do processo do lado
// Windows, mas a lista enriquecida marca wsl=true. A conversão para /mnt/...
// deve seguir o campo, não só o cwd.
func TestPaneLooksWSLUsesEnrichedFlag(t *testing.T) {
	h := &hub{lastList: []byte(`{"ev":"list","panes":[` +
		`{"pane_id":4,"cwd":"file:///C:/Users/dev/","wsl":true},` +
		`{"pane_id":5,"cwd":"file:///C:/demo/api/"},` +
		`{"pane_id":6,"cwd":"file://pc/home/dev"}]}`)}
	if !h.paneLooksWSL(4) {
		t.Fatal("pane WSL com cwd do Windows deveria ser WSL")
	}
	if h.paneLooksWSL(5) {
		t.Fatal("pane PowerShell não é WSL")
	}
	if !h.paneLooksWSL(6) {
		t.Fatal("cwd Linux continua valendo")
	}
	if got := filePathText(`C:\tmp\bethstudio\clipboard-images\a.pdf`, h.paneLooksWSL(4)); got != "/mnt/c/tmp/bethstudio/clipboard-images/a.pdf" {
		t.Fatalf("caminho %q", got)
	}
}
