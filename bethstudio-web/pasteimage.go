package main

// pasteimage.go — colar imagens e arquivos no terminal, como a GUI.
//
// Mesma regra de wtinator/src/image_paste.rs (paste_image_to_pane):
//   - pasta: C:\tmp\bethstudio\clipboard-images se C:\tmp existir, senao
//     %TEMP%\bethstudio\clipboard-images;
//   - nome: clipboard-<largura>x<altura>-<unix millis>.png, sempre PNG
//     (a GUI reencoda o bitmap da area de transferencia para PNG);
//   - texto colado (send_paste, bracketed): ![image](C:/tmp/.../x.png)
//     com barras normais; em pane WSL o caminho vira /mnt/c/... pela regra
//     de wtinator::wsl::windows_path_to_wsl_mount.
//
// A GUI sabe que o pane e' WSL pelo dominio (WSL:<distro>) ou pelo processo
// (wsl.exe). A ponte nao informa nenhum dos dois; o web usa o cwd do pane:
// caminho Linux (file://host/home/..., /mnt/...) = WSL; caminho com letra de
// drive (file:///C:/...) = Windows. O navegador pode forcar com wsl=1/0.
//
// Arquivos que nao sao imagem (soltos sobre o terminal, ou copiados no
// Explorer e colados): o navegador nao da' o caminho real no soltar, entao
// salvamos uma copia na mesma pasta (file-<millis>-<nome>) e colamos o
// caminho da copia. Colar (Ctrl+V ou o botao Colar) le a lista de arquivos
// do Explorer (CF_HDROP), copia cada um para essa pasta — PDF, video, o
// que for — e cola o caminho. Imagem de arquivo vira ![image](caminho);
// o resto cola o caminho puro, para o agente abrir. Pasta, ou arquivo
// maior que o limite, cola o caminho original (convertido no WSL).

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/webp"
)

const (
	maxPasteBytes         = 25 << 20
	maxPastePixels        = 60_000_000
	maxClipboardCopyBytes = 2 << 30
	maxClipboardFiles     = 8
)

var allowedImageTypes = map[string]bool{
	"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true, "image/bmp": true,
}

// imageDir: as in image_paste.rs temp_image_dir().
var imageDir = func() string {
	if st, err := os.Stat(`C:\tmp`); err == nil && st.IsDir() {
		return filepath.Join(`C:\tmp`, "bethstudio", "clipboard-images")
	}
	return filepath.Join(os.TempDir(), "bethstudio", "clipboard-images")
}

var nowMillis = func() int64 { return time.Now().UnixMilli() }

// windowsPathToWSLMount ports wtinator::wsl::windows_path_to_wsl_mount.
func windowsPathToWSLMount(p string) string {
	n := strings.ReplaceAll(p, `\`, "/")
	if len(n) >= 3 && isASCIILetter(n[0]) && n[1] == ':' && n[2] == '/' {
		drive := strings.ToLower(n[:1])
		rest := strings.TrimLeft(n[3:], "/")
		if rest == "" {
			return "/mnt/" + drive
		}
		return "/mnt/" + drive + "/" + rest
	}
	return n
}

func isASCIILetter(b byte) bool { return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') }

// markdownImageLink ports image_paste.rs markdown_image_link.
func markdownImageLink(path string, wsl bool) string {
	link := strings.ReplaceAll(path, `\`, "/")
	if wsl {
		link = windowsPathToWSLMount(link)
	}
	return "![image](" + link + ")"
}

// cwdLooksWSL: web-side stand-in for wsl::pane_is_wsl (see header).
func cwdLooksWSL(cwd string) bool {
	if !strings.HasPrefix(cwd, "file://") {
		return false
	}
	rest := cwd[len("file://"):]
	i := strings.IndexByte(rest, '/')
	if i < 0 {
		return false
	}
	path := rest[i:]
	if len(path) >= 3 && path[0] == '/' && isASCIILetter(path[1]) && path[2] == ':' {
		return false // /C:/... = Windows
	}
	return strings.HasPrefix(path, "/")
}

// savePastedImage decodes any allowed image, re-encodes it as PNG and saves
// it like the GUI. Returns the saved path.
func savePastedImage(data []byte) (string, int, int, error) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return "", 0, 0, fmt.Errorf("imagem inválida: %w", err)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width*cfg.Height > maxPastePixels {
		return "", 0, 0, errors.New("imagem grande demais")
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return "", 0, 0, fmt.Errorf("imagem inválida: %w", err)
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return "", 0, 0, err
	}
	dir := imageDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", 0, 0, err
	}
	b := img.Bounds()
	path := filepath.Join(dir, fmt.Sprintf("clipboard-%dx%d-%d.png", b.Dx(), b.Dy(), nowMillis()))
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		return "", 0, 0, err
	}
	return path, b.Dx(), b.Dy(), nil
}

var unsafeNameRe = regexp.MustCompile(`[^A-Za-z0-9._ -]+`)

func pasteBaseName(name string) string {
	base := filepath.Base(strings.ReplaceAll(name, `\`, "/"))
	base = strings.Trim(unsafeNameRe.ReplaceAllString(base, "_"), " .")
	if base == "" {
		base = "arquivo"
	}
	if len(base) > 120 {
		base = base[len(base)-120:]
	}
	return base
}

func savePastedFile(data []byte, name string) (string, error) {
	dir := imageDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, fmt.Sprintf("file-%d-%s", nowMillis(), pasteBaseName(name)))
	return path, os.WriteFile(path, data, 0o644)
}

func isClipboardImageName(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp":
		return true
	default:
		return false
	}
}

// clipboardFilePaths lists files copied in Explorer (CF_HDROP).
// Tests replace it. Empty list means the clipboard has no files.
var clipboardFilePaths = readOSClipboardFiles

// stageClipboardEntry copies a regular file into the clipboard folder.
// Directories and files over maxClipboardCopyBytes stay put (copied=false).
func stageClipboardEntry(src string) (saved string, copied bool, err error) {
	st, err := os.Stat(src)
	if err != nil {
		return "", false, err
	}
	if st.IsDir() || st.Size() > maxClipboardCopyBytes {
		return src, false, nil
	}
	in, err := os.Open(src)
	if err != nil {
		return "", false, err
	}
	defer in.Close()
	dir := imageDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", false, err
	}
	path := filepath.Join(dir, fmt.Sprintf("file-%d-%s", nowMillis(), pasteBaseName(src)))
	out, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return "", false, err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		_ = os.Remove(path)
		return "", false, copyErr
	}
	if closeErr != nil {
		_ = os.Remove(path)
		return "", false, closeErr
	}
	return path, true, nil
}

func textForStaged(path string, copied bool, wsl bool) string {
	if copied && isClipboardImageName(path) {
		return markdownImageLink(path, wsl)
	}
	return filePathText(path, wsl)
}

// filePathText: plain path for a dropped file (quoted when it has spaces).
func filePathText(path string, wsl bool) string {
	p := path
	if wsl {
		p = windowsPathToWSLMount(p)
	}
	if strings.ContainsAny(p, " \t") {
		return `"` + p + `"`
	}
	return p
}

// servePaste handles POST /api/paste-image and /api/paste-file
// (?pane_id=N[&wsl=0|1][&name=...]; body = raw bytes).
func (s *server) servePaste(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		return
	}
	if s.hub.readOnly {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "modo somente leitura: colar desabilitado"})
		return
	}
	q := r.URL.Query()
	pane, err := strconv.Atoi(q.Get("pane_id"))
	if err != nil || pane < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "pane_id inválido"})
		return
	}
	ctype := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]))
	isImage := r.URL.Path == "/api/paste-image"
	if isImage && !allowedImageTypes[ctype] {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "tipo de imagem não aceito: " + ctype})
		return
	}
	// Formularios HTML nao mandam estes tipos: evita POST de outro site.
	if !isImage && ctype != "application/octet-stream" && !allowedImageTypes[ctype] {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "use application/octet-stream"})
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxPasteBytes))
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "arquivo grande demais (máx. 25 MB)"})
		return
	}
	if len(data) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "vazio"})
		return
	}
	wsl := s.hub.paneLooksWSL(pane)
	switch q.Get("wsl") {
	case "1":
		wsl = true
	case "0":
		wsl = false
	}
	var path, text string
	if isImage {
		path, _, _, err = savePastedImage(data)
		if err == nil {
			text = markdownImageLink(path, wsl)
		}
	} else {
		path, err = savePastedFile(data, q.Get("name"))
		if err == nil {
			text = filePathText(path, wsl)
		}
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err := s.hub.bridge.write(map[string]any{"op": "paste", "pane_id": pane, "data": text}); err != nil {
		msg := err.Error()
		if errors.Is(err, errBridgeDown) {
			msg = msgConnecting
		}
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": msg, "path": path})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": path, "text": text, "wsl": wsl})
}

// servePasteClipboard handles POST /api/paste-clipboard?pane_id=N.
// It reads Explorer's copied files, copies each into the clipboard folder,
// and pastes the path (markdown for images). {"empty":true} when there is
// no file list, so the page can fall back to a bitmap or plain text.
func (s *server) servePasteClipboard(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		return
	}
	if s.hub.readOnly {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "modo somente leitura: colar desabilitado"})
		return
	}
	pane, err := strconv.Atoi(r.URL.Query().Get("pane_id"))
	if err != nil || pane < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "pane_id inválido"})
		return
	}
	paths, err := clipboardFilePaths()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"empty": true})
		return
	}
	if len(paths) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"empty": true})
		return
	}
	note := ""
	if len(paths) > maxClipboardFiles {
		paths = paths[:maxClipboardFiles]
		note = "Só os 8 primeiros arquivos."
	}
	wsl := s.hub.paneLooksWSL(pane)
	switch r.URL.Query().Get("wsl") {
	case "1":
		wsl = true
	case "0":
		wsl = false
	}
	saved := make([]string, 0, len(paths))
	texts := make([]string, 0, len(paths))
	var sawDir, sawBig bool
	for _, src := range paths {
		st, statErr := os.Stat(src)
		if statErr != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": statErr.Error()})
			return
		}
		if st.IsDir() {
			sawDir = true
		} else if st.Size() > maxClipboardCopyBytes {
			sawBig = true
		}
		dest, copied, err := stageClipboardEntry(src)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		saved = append(saved, dest)
		texts = append(texts, textForStaged(dest, copied, wsl))
	}
	if sawBig {
		note = strings.TrimSpace(note + " Arquivo grande demais para copiar: caminho original colado.")
	} else if sawDir {
		note = strings.TrimSpace(note + " Pasta: caminho original.")
	}
	text := strings.Join(texts, "\n")
	if err := s.hub.bridge.write(map[string]any{"op": "paste", "pane_id": pane, "data": text}); err != nil {
		msg := err.Error()
		if errors.Is(err, errBridgeDown) {
			msg = msgConnecting
		}
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": msg})
		return
	}
	out := map[string]any{"paths": saved, "text": text, "wsl": wsl}
	if note != "" {
		out["note"] = note
	}
	writeJSON(w, http.StatusOK, out)
}

// paneLooksWSL: o pane roda no WSL? Vale o campo "wsl" da lista enriquecida
// (kind wsl, ou agente com cwd Linux) e, na falta dele, o cwd. Só o cwd não
// basta: um terminal WSL aberto pelo Studio lista o cwd do processo do lado
// Windows (file:///C:/Users/...), não o do shell Linux.
func (h *hub) paneLooksWSL(pane int) bool {
	h.mu.Lock()
	list := h.lastList
	h.mu.Unlock()
	var ev struct {
		Panes []struct {
			PaneID int    `json:"pane_id"`
			Cwd    string `json:"cwd"`
			WSL    bool   `json:"wsl"`
		} `json:"panes"`
	}
	if list == nil || jsonUnmarshal(list, &ev) != nil {
		return false
	}
	for _, p := range ev.Panes {
		if p.PaneID == pane {
			return p.WSL || cwdLooksWSL(p.Cwd)
		}
	}
	return false
}
