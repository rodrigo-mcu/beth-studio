package main

// localfile_actions.go — acoes do painel de preview de arquivo local (ver
// frontend/src/components/FilePreviewPanel.tsx), alem da leitura
// (localfile.go):
//
//   POST /api/local-file/save-as {"path"}  dialogo nativo "Salvar como"
//        (mesmo nome por padrao) e copia o conteudo CRU do arquivo de
//        origem para o destino escolhido;
//   POST /api/local-file/reveal  {"path"}  abre a pasta no Explorer com o
//        arquivo selecionado (vale para \\wsl.localhost\... e \\wsl$\...).
//
// A origem passa pela mesma validacao do preview (absoluto, sem esquema,
// sem "..", extensao da lista). O destino vem do dialogo do Windows, mas e'
// validado de novo (saveAsTarget) antes de escrever.

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

// readPathBody: {"path": "..."} validado como no preview, com extensao permitida.
func readPathBody(w http.ResponseWriter, r *http.Request) (string, bool) {
	if r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "use POST application/json", http.StatusBadRequest)
		return "", false
	}
	var req struct {
		Path string `json:"path"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
		return "", false
	}
	path, err := validateLocalPath(req.Path)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return "", false
	}
	if _, category := localFileCategory(path); category == "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "tipo de arquivo não suportado"})
		return "", false
	}
	return path, true
}

// saveAsTarget: destino do "Salvar como". Absoluto (unidade ou UNC), sem
// "..", com uma extensao permitida (texto/imagem); sem extensao, ganha a da
// origem. Nunca o proprio arquivo de origem.
func saveAsTarget(dest, src string) (string, error) {
	dest = strings.TrimSpace(dest)
	if dest == "" {
		return "", errors.New("destino vazio")
	}
	srcExt := strings.ToLower(filepath.Ext(src))
	if filepath.Ext(dest) == "" {
		dest += srcExt
	}
	clean, err := validateLocalPath(dest)
	if err != nil {
		return "", err
	}
	if _, category := localFileCategory(clean); category == "" {
		return "", errors.New("extensão não permitida para salvar")
	}
	if cs, err := validateLocalPath(src); err == nil && strings.EqualFold(cs, clean) {
		return "", errors.New("o destino é o próprio arquivo")
	}
	return clean, nil
}

// copyLocalFile copia o conteudo cru (arquivo temporario + rename, para nao
// deixar um destino pela metade).
func copyLocalFile(src, dest string) error {
	in, err := openLocalFile(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp, err := os.CreateTemp(filepath.Dir(dest), ".bethstudio-save-*")
	if err != nil {
		return err
	}
	if _, err := io.Copy(tmp, in); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	if err := os.Rename(tmp.Name(), dest); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return nil
}

// saveDialog: variavel para os testes trocarem o dialogo nativo.
var saveDialog = nativeSaveDialog

var saveDialogBusy sync.Mutex

func serveLocalFileSaveAs(w http.ResponseWriter, r *http.Request) {
	src, ok := readPathBody(w, r)
	if !ok {
		return
	}
	if !saveDialogBusy.TryLock() {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "já existe uma janela de salvar aberta"})
		return
	}
	defer saveDialogBusy.Unlock()
	chosen, picked, err := saveDialog(filepath.Base(src), strings.ToLower(filepath.Ext(src)))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "não foi possível abrir a janela de salvar"})
		return
	}
	if !picked {
		writeJSON(w, http.StatusOK, map[string]any{"canceled": true})
		return
	}
	dest, err := saveAsTarget(chosen, src)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err := copyLocalFile(src, dest); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": friendlyFileError(err)})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": dest})
}

// revealLocal: variavel para os testes (nao abrir o Explorer de verdade).
var revealLocal = func(path string) error { return revealInExplorer(path, true) }

func serveLocalFileReveal(w http.ResponseWriter, r *http.Request) {
	path, ok := readPathBody(w, r)
	if !ok {
		return
	}
	f, err := openLocalFile(path)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": friendlyFileError(err)})
		return
	}
	path = f.Name() // \\wsl.localhost ou \\wsl$, o que existir
	f.Close()
	if err := revealLocal(path); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "não foi possível abrir a pasta"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": path})
}

// --- dialogo nativo (comdlg32 GetSaveFileNameW) ---------------------------

var (
	comdlg32             = windows.NewLazySystemDLL("comdlg32.dll")
	procGetSaveFileNameW = comdlg32.NewProc("GetSaveFileNameW")
	procCoInitializeEx   = ole32.NewProc("CoInitializeEx")
	procCoUninitialize   = ole32.NewProc("CoUninitialize")
)

type openFileNameW struct {
	lStructSize       uint32
	hwndOwner         uintptr
	hInstance         uintptr
	lpstrFilter       *uint16
	lpstrCustomFilter *uint16
	nMaxCustFilter    uint32
	nFilterIndex      uint32
	lpstrFile         *uint16
	nMaxFile          uint32
	lpstrFileTitle    *uint16
	nMaxFileTitle     uint32
	lpstrInitialDir   *uint16
	lpstrTitle        *uint16
	flags             uint32
	nFileOffset       uint16
	nFileExtension    uint16
	lpstrDefExt       *uint16
	lCustData         uintptr
	lpfnHook          uintptr
	lpTemplateName    *uint16
	pvReserved        uintptr
	dwReserved        uint32
	flagsEx           uint32
}

const (
	ofnOverwritePrompt = 0x00000002
	ofnNoChangeDir     = 0x00000008
	ofnPathMustExist   = 0x00000800
	ofnExplorer        = 0x00080000
)

// saveFilter: "Arquivo .md\0*.md\0Todos os arquivos\0*.*\0\0" em UTF-16.
func saveFilter(ext string) []uint16 {
	var parts []string
	if ext != "" {
		parts = append(parts, "Arquivo "+ext, "*"+ext)
	}
	parts = append(parts, "Todos os arquivos", "*.*")
	var out []uint16
	for _, p := range parts {
		out = append(out, utf16.Encode([]rune(p))...)
		out = append(out, 0)
	}
	return append(out, 0)
}

// nativeSaveDialog mostra o "Salvar como" do Windows (dono: a janela do
// app). Devolve o caminho escolhido; picked=false se o usuario cancelou.
func nativeSaveDialog(defaultName, ext string) (string, bool, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if r, _, _ := procCoInitializeEx.Call(0, 0x2 /* COINIT_APARTMENTTHREADED */); r == 0 || r == 1 {
		defer procCoUninitialize.Call()
	}
	buf := make([]uint16, 32768)
	copy(buf, utf16.Encode([]rune(defaultName)))
	filter := saveFilter(ext)
	title, _ := windows.UTF16PtrFromString("Salvar como")
	var defExt *uint16
	if e := strings.TrimPrefix(ext, "."); e != "" {
		defExt, _ = windows.UTF16PtrFromString(e)
	}
	ofn := openFileNameW{
		hwndOwner:    hostHWND,
		lpstrFilter:  &filter[0],
		nFilterIndex: 1,
		lpstrFile:    &buf[0],
		nMaxFile:     uint32(len(buf)),
		lpstrTitle:   title,
		lpstrDefExt:  defExt,
		flags:        ofnOverwritePrompt | ofnNoChangeDir | ofnPathMustExist | ofnExplorer,
	}
	ofn.lStructSize = uint32(unsafe.Sizeof(ofn))
	r, _, _ := procGetSaveFileNameW.Call(uintptr(unsafe.Pointer(&ofn)))
	runtime.KeepAlive(filter)
	runtime.KeepAlive(buf)
	if r == 0 {
		return "", false, nil // cancelado (ou erro do dialogo: tratado igual)
	}
	return windows.UTF16ToString(buf), true, nil
}
