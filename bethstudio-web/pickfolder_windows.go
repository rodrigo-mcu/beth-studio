package main

// pickfolder_windows.go — POST /api/pick-folder {"initial"?} abre o seletor
// de pasta do Windows (a mesma janela do Explorer) e devolve o caminho.

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// pickFolderDialog: os testes trocam o dialogo nativo.
var pickFolderDialog = nativePickFolder

// pickFolderInitial devolve a pasta inicial do dialogo, ou "" quando o
// caminho nao existe, nao e' pasta, ou nao passa na validacao.
func pickFolderInitial(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	clean, err := validateLocalPath(raw)
	if err != nil {
		return ""
	}
	st, err := os.Stat(clean)
	if err != nil || !st.IsDir() {
		return ""
	}
	return clean
}

func servePickFolder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Initial string `json:"initial"`
	}
	err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req)
	if err != nil && err != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
		return
	}
	if !saveDialogBusy.TryLock() {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "já existe uma janela do Windows aberta"})
		return
	}
	defer saveDialogBusy.Unlock()
	path, picked, err := pickFolderDialog(pickFolderInitial(req.Initial))
	if err != nil {
		log.Printf("pick-folder: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "não foi possível abrir a janela de pastas"})
		return
	}
	if !picked {
		writeJSON(w, http.StatusOK, map[string]any{"picked": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"picked": true, "path": path})
}

var (
	procCoCreateInstance            = ole32.NewProc("CoCreateInstance")
	procSHCreateItemFromParsingName = windows.NewLazySystemDLL("shell32.dll").NewProc("SHCreateItemFromParsingName")

	clsidFileOpenDialog = windows.GUID{
		Data1: 0xDC1C5A9C, Data2: 0xE88A, Data3: 0x4DDE,
		Data4: [8]byte{0xA5, 0xA1, 0x60, 0xF8, 0x2A, 0x20, 0xAE, 0xF7},
	}
	iidIFileOpenDialog = windows.GUID{
		Data1: 0xD57C7288, Data2: 0xD4AD, Data3: 0x4768,
		Data4: [8]byte{0xBE, 0x02, 0x9D, 0x96, 0x95, 0x32, 0xD9, 0x60},
	}
	iidIShellItem = windows.GUID{
		Data1: 0x43826D1E, Data2: 0xE718, Data3: 0x42EE,
		Data4: [8]byte{0xBC, 0x55, 0xA1, 0xE2, 0x61, 0xC3, 0x7B, 0xFE},
	}
)

const (
	clsctxInprocServer = 1
	fosPickFolders     = 0x00000020
	fosForceFileSystem = 0x00000040
	fosPathMustExist   = 0x00000800
	fosNoChangeDir     = 0x00000008
	sigdnFileSysPath   = 0x80058000
	hrCanceled         = 0x800704C7
)

// IFileOpenDialog herda IFileDialog. Slots: 3 Show, 9 SetOptions,
// 10 GetOptions, 12 SetFolder, 17 SetTitle, 18 SetOkButtonLabel, 20 GetResult.
// IShellItem: 5 GetDisplayName.

func comRelease(obj uintptr) {
	if obj != 0 {
		comCall(obj, 2)
	}
}

func hrFailed(hr uintptr) bool {
	return int32(hr) < 0
}

func nativePickFolder(initial string) (string, bool, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if r, _, _ := procCoInitializeEx.Call(0, 0x2 /* COINIT_APARTMENTTHREADED */); r == 0 || r == 1 {
		defer procCoUninitialize.Call()
	}

	var dialog uintptr
	hr, _, _ := procCoCreateInstance.Call(
		uintptr(unsafe.Pointer(&clsidFileOpenDialog)),
		0,
		clsctxInprocServer,
		uintptr(unsafe.Pointer(&iidIFileOpenDialog)),
		uintptr(unsafe.Pointer(&dialog)),
	)
	if hrFailed(hr) || dialog == 0 {
		return "", false, fmt.Errorf("CoCreateInstance: 0x%08X", uint32(hr))
	}
	defer comRelease(dialog)

	var opts uint32
	if hr = comCall(dialog, 10, uintptr(unsafe.Pointer(&opts))); hrFailed(hr) {
		return "", false, fmt.Errorf("GetOptions: 0x%08X", uint32(hr))
	}
	opts |= fosPickFolders | fosForceFileSystem | fosPathMustExist | fosNoChangeDir
	if hr = comCall(dialog, 9, uintptr(opts)); hrFailed(hr) {
		return "", false, fmt.Errorf("SetOptions: 0x%08X", uint32(hr))
	}
	title, _ := windows.UTF16PtrFromString("Escolher pasta inicial")
	okLabel, _ := windows.UTF16PtrFromString("Selecionar pasta")
	_ = comCall(dialog, 17, uintptr(unsafe.Pointer(title)))
	_ = comCall(dialog, 18, uintptr(unsafe.Pointer(okLabel)))
	runtime.KeepAlive(title)
	runtime.KeepAlive(okLabel)

	if initial != "" {
		if item, ok := shellItemFromPath(initial); ok {
			_ = comCall(dialog, 12, item)
			comRelease(item)
		}
	}

	hr = comCall(dialog, 3, hostHWND)
	if uint32(hr) == hrCanceled {
		return "", false, nil
	}
	if hrFailed(hr) {
		return "", false, fmt.Errorf("Show: 0x%08X", uint32(hr))
	}

	var result uintptr
	if hr = comCall(dialog, 20, uintptr(unsafe.Pointer(&result))); hrFailed(hr) || result == 0 {
		return "", false, fmt.Errorf("GetResult: 0x%08X", uint32(hr))
	}
	defer comRelease(result)

	var name *uint16
	if hr = comCall(result, 5, sigdnFileSysPath, uintptr(unsafe.Pointer(&name))); hrFailed(hr) || name == nil {
		return "", false, fmt.Errorf("GetDisplayName: 0x%08X", uint32(hr))
	}
	defer procCoTaskMemFree.Call(uintptr(unsafe.Pointer(name)))
	return windows.UTF16PtrToString(name), true, nil
}

func shellItemFromPath(path string) (uintptr, bool) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, false
	}
	var item uintptr
	hr, _, _ := procSHCreateItemFromParsingName.Call(
		uintptr(unsafe.Pointer(p)),
		0,
		uintptr(unsafe.Pointer(&iidIShellItem)),
		uintptr(unsafe.Pointer(&item)),
	)
	runtime.KeepAlive(p)
	if hrFailed(hr) || item == 0 {
		return 0, false
	}
	return item, true
}
