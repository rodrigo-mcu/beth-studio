package main

// localfile_edit.go — o painel de arquivo (FilePreviewPanel.tsx) tambem
// edita texto:
//
//   POST /api/local-file/write {"path","content","mtime","force"}  grava o
//        texto no PROPRIO arquivo (so' .md/.markdown/.txt/.log, que ja'
//        existe). "mtime" e' o X-File-Mtime da leitura: se o arquivo mudou
//        no disco depois disso (um agente editou, outro editor salvou),
//        responde 409 {"conflict":true} e so' sobrescreve com "force".
//        Grava no lugar (truncar + escrever), nao arquivo temporario +
//        rename: rename trocaria um link simbolico (CLAUDE.md -> AGENTS.md)
//        por um arquivo comum.
//   POST /api/local-file/open-dialog {"initial"?}  janela "Abrir" do
//        Windows (texto e imagens da lista permitida); devolve o caminho.

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

// localTextWriteMax: o que o painel edita (so' arquivo mostrado inteiro,
// ate' localTextPreviewMax) com folga para o que o usuario digitar.
const localTextWriteMax = 8 << 20

func fileMtime(st os.FileInfo) string { return strconv.FormatInt(st.ModTime().UnixNano(), 10) }

func serveLocalFileWrite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "use POST application/json", http.StatusBadRequest)
		return
	}
	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
		Mtime   string `json:"mtime"`
		Force   bool   `json:"force"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 2*localTextWriteMax)).Decode(&req) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido (ou texto grande demais)"})
		return
	}
	if len(req.Content) > localTextWriteMax {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "texto grande demais para salvar pelo painel (mais de 8 MB)"})
		return
	}
	path, err := validateLocalPath(req.Path)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if _, category := localFileCategory(path); category != "text" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "só arquivos de texto (.md, .txt, .log) podem ser editados"})
		return
	}
	// o arquivo tem que existir (\\wsl.localhost ou \\wsl$, o que existir)
	f, err := openLocalFile(path)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": friendlyFileError(err)})
		return
	}
	path = f.Name()
	st, err := f.Stat()
	f.Close()
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": friendlyFileError(err)})
		return
	}
	if st.IsDir() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "é uma pasta, não um arquivo"})
		return
	}
	if req.Mtime != "" && !req.Force && req.Mtime != fileMtime(st) {
		writeJSON(w, http.StatusConflict, map[string]any{"conflict": true, "error": "o arquivo mudou no disco desde que foi aberto"})
		return
	}
	out, err := os.OpenFile(path, os.O_WRONLY|os.O_TRUNC, 0)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": friendlyWriteError(err)})
		return
	}
	_, werr := io.WriteString(out, req.Content)
	cerr := out.Close()
	if werr != nil || cerr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "não foi possível gravar o arquivo inteiro"})
		return
	}
	st, err = os.Stat(path)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]string{"path": path})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": path, "mtime": fileMtime(st)})
}

// serveLocalFileCreate: POST /api/local-file/create {"path","content"?} cria
// um arquivo de texto NOVO (.md, .txt, .log). Nunca sobrescreve: se já
// existir, 409. A pasta tem que existir. Responde {"path","mtime"}.
func serveLocalFileCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "use POST application/json", http.StatusBadRequest)
		return
	}
	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 2*localTextWriteMax)).Decode(&req) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido (ou texto grande demais)"})
		return
	}
	path, err := validateLocalPath(req.Path)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if _, category := localFileCategory(path); category != "text" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "o nome precisa terminar em .md, .txt ou .log"})
		return
	}
	if err := validNewFileName(filepath.Base(path)); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if st, err := os.Stat(filepath.Dir(path)); err != nil || !st.IsDir() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "a pasta não existe"})
		return
	}
	out, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		if os.IsExist(err) {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "já existe um arquivo com esse nome nesta pasta"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": friendlyWriteError(err)})
		return
	}
	_, werr := io.WriteString(out, req.Content)
	if cerr := out.Close(); werr != nil || cerr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "não foi possível gravar o arquivo"})
		return
	}
	st, err := os.Stat(path)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]string{"path": path})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": path, "mtime": fileMtime(st)})
}

// validNewFileName: nome que o Windows aceita (sem \ / : * ? " < > |, sem
// nome reservado como CON ou NUL, sem terminar em ponto ou espaço).
func validNewFileName(name string) error {
	if name == "" || len(name) > 200 {
		return errors.New("nome inválido")
	}
	if strings.ContainsAny(name, `\/:*?"<>|`) || strings.IndexFunc(name, func(r rune) bool { return r < 0x20 }) >= 0 {
		return errors.New(`o nome não pode ter \ / : * ? " < > |`)
	}
	if strings.HasSuffix(name, ".") || strings.HasSuffix(name, " ") || strings.HasPrefix(name, " ") {
		return errors.New("o nome não pode começar com espaço nem terminar em ponto ou espaço")
	}
	base := strings.ToUpper(strings.TrimSuffix(name, filepath.Ext(name)))
	switch base {
	case "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
		"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9":
		return errors.New("esse nome é reservado pelo Windows")
	}
	return nil
}

func friendlyWriteError(err error) string {
	switch {
	case os.IsNotExist(err):
		return "o arquivo não existe (ou já foi movido/apagado)"
	case os.IsPermission(err):
		return "sem permissão para gravar este arquivo (somente leitura?)"
	default:
		return "não foi possível gravar o arquivo"
	}
}

// openDialog: os testes trocam o dialogo nativo.
var openDialog = nativeOpenDialog

func serveLocalFileOpenDialog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Initial string `json:"initial"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil && err != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
		return
	}
	if !saveDialogBusy.TryLock() {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "já existe uma janela do Windows aberta"})
		return
	}
	defer saveDialogBusy.Unlock()
	chosen, picked, err := openDialog(pickFolderInitial(req.Initial))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "não foi possível abrir a janela de abrir arquivo"})
		return
	}
	if !picked {
		writeJSON(w, http.StatusOK, map[string]any{"canceled": true})
		return
	}
	path, err := validateLocalPath(chosen)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if _, category := localFileCategory(path); category == "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "tipo de arquivo não suportado (use .md, .txt, .log ou imagem)"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": path})
}

var procGetOpenFileNameW = comdlg32.NewProc("GetOpenFileNameW")

const ofnFileMustExist = 0x00001000

// openFilter: texto primeiro (o uso normal), depois imagens.
func openFilter() []uint16 {
	parts := []string{
		"Texto e Markdown (*.md, *.txt, *.log)", "*.md;*.markdown;*.txt;*.log",
		"Imagens", "*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp;*.svg",
	}
	var out []uint16
	for _, p := range parts {
		out = append(out, utf16.Encode([]rune(p))...)
		out = append(out, 0)
	}
	return append(out, 0)
}

// nativeOpenDialog mostra o "Abrir" do Windows (dono: a janela do app).
func nativeOpenDialog(initialDir string) (string, bool, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if r, _, _ := procCoInitializeEx.Call(0, 0x2 /* COINIT_APARTMENTTHREADED */); r == 0 || r == 1 {
		defer procCoUninitialize.Call()
	}
	buf := make([]uint16, 32768)
	filter := openFilter()
	title, _ := windows.UTF16PtrFromString("Abrir arquivo")
	var initial *uint16
	if initialDir != "" {
		initial, _ = windows.UTF16PtrFromString(initialDir)
	}
	ofn := openFileNameW{
		hwndOwner:       hostHWND,
		lpstrFilter:     &filter[0],
		nFilterIndex:    1,
		lpstrFile:       &buf[0],
		nMaxFile:        uint32(len(buf)),
		lpstrInitialDir: initial,
		lpstrTitle:      title,
		flags:           ofnFileMustExist | ofnNoChangeDir | ofnPathMustExist | ofnExplorer,
	}
	ofn.lStructSize = uint32(unsafe.Sizeof(ofn))
	r, _, _ := procGetOpenFileNameW.Call(uintptr(unsafe.Pointer(&ofn)))
	runtime.KeepAlive(filter)
	runtime.KeepAlive(buf)
	runtime.KeepAlive(initial)
	if r == 0 {
		return "", false, nil // cancelado (ou erro do dialogo: tratado igual)
	}
	return windows.UTF16ToString(buf), true, nil
}
