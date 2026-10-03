//go:build windows

package main

// startup_windows.go — abertura do Beth Studio:
//
//   - um Studio só: o segundo clique (bandeja, atalho) não abre outra cópia;
//     traz a janela aberta para a frente e sai. Duas cópias disputavam a
//     ligação do celular ("ligado… caiu…" a cada meio segundo). Só a janela
//     principal: SFTP, Banco de dados e --no-window não entram na trava.
//   - "Abrindo Beth Studio…" desenhado pela própria janela nativa enquanto o
//     WebView2 inicia (antes disso era um retângulo vazio, parecia travado).
//   - "abertura:" no log com o tempo de cada fase (processo → janela →
//     WebView2 → página); a página completa com as fases dela (startup.ts).

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// processStart: início do processo (aprox.), base dos tempos da abertura.
var processStart = time.Now()

func sinceStart() string {
	return fmt.Sprintf("%.2fs", time.Since(processStart).Seconds())
}

var (
	procBeginPaint               = user32.NewProc("BeginPaint")
	procEndPaint                 = user32.NewProc("EndPaint")
	procGetClientRect            = user32.NewProc("GetClientRect")
	procDrawTextW                = user32.NewProc("DrawTextW")
	procIsWindow                 = user32.NewProc("IsWindow")
	procGetWindowThreadProcessId = user32.NewProc("GetWindowThreadProcessId")
	procSetBkMode                = gdi32.NewProc("SetBkMode")
	procSetTextColor             = gdi32.NewProc("SetTextColor")
	procCreateFontW              = gdi32.NewProc("CreateFontW")
	procSelectObject             = gdi32.NewProc("SelectObject")
	procDeleteObject             = gdi32.NewProc("DeleteObject")
	procCreateMutexW             = kernel32.NewProc("CreateMutexW")
)

const wmPaint = 0x000F

// --- um Studio só -----------------------------------------------------------

const studioMutexName = `Local\BethStudioMain`

// studioMainWindow: esta execução é o Studio principal (grava o HWND para
// o próximo clique achar a janela).
var studioMainWindow bool

func studioHWNDFile() string {
	if d := appDataDir(); d != "" {
		return filepath.Join(d, "studio.hwnd")
	}
	return ""
}

// claimSingleStudio: true = somos o único Studio (segue abrindo). false =
// já existe um: a janela dele veio para a frente, este processo deve sair.
// O mutex fica aberto até o processo terminar (o Windows o libera).
func claimSingleStudio() bool {
	name, _ := windows.UTF16PtrFromString(studioMutexName)
	h, _, err := procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if h == 0 {
		log.Printf("studio: sem trava de instância (%v); seguindo", err)
		return true
	}
	if err != windows.ERROR_ALREADY_EXISTS {
		studioMainWindow = true
		return true
	}
	// o outro Studio pode estar nascendo: espera a janela dele por até 5 s
	for i := 0; i < 50; i++ {
		if hwnd := existingStudioWindow(); hwnd != 0 {
			bringToFront(hwnd)
			log.Printf("studio: já aberto (janela %#x); trazido para a frente, esta cópia sai", hwnd)
			return false
		}
		time.Sleep(100 * time.Millisecond)
	}
	log.Printf("studio: já aberto, mas a janela não apareceu em 5 s; esta cópia sai")
	return false
}

// existingStudioWindow: HWND gravado pelo Studio principal, se ainda for
// uma janela viva daquele mesmo processo.
func existingStudioWindow() uintptr {
	p := studioHWNDFile()
	if p == "" {
		return 0
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return 0
	}
	f := strings.Fields(string(b))
	if len(f) != 2 {
		return 0
	}
	pid, err1 := strconv.ParseUint(f[0], 10, 32)
	hwnd, err2 := strconv.ParseUint(f[1], 10, 64)
	if err1 != nil || err2 != nil || hwnd == 0 {
		return 0
	}
	if ok, _, _ := procIsWindow.Call(uintptr(hwnd)); ok == 0 {
		return 0
	}
	var owner uint32
	_, _, _ = procGetWindowThreadProcessId.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&owner)))
	if uint64(owner) != pid {
		return 0 // HWND reaproveitado por outro processo
	}
	return uintptr(hwnd)
}

func recordStudioWindow(hwnd uintptr) {
	if !studioMainWindow {
		return
	}
	if p := studioHWNDFile(); p != "" {
		_ = os.WriteFile(p, []byte(fmt.Sprintf("%d %d\n", os.Getpid(), hwnd)), 0o644)
	}
}

func bringToFront(hwnd uintptr) {
	if iconic, _, _ := procIsIconicW.Call(hwnd); iconic != 0 {
		_, _, _ = procShowWindow.Call(hwnd, swRestore)
	} else {
		_, _, _ = procShowWindow.Call(hwnd, swShow)
	}
	_, _, _ = procSetForegroundWindow.Call(hwnd)
}

// --- "Abrindo Beth Studio…" na janela nativa --------------------------------

// splashFG: cor do texto (COLORREF 0x00BBGGRR); o fundo é o pincel da classe.
var splashFG uint32 = 0x00B8B8B8

// webviewReady: o WebView2 já cobre a janela (o texto não é mais desenhado).
var webviewReady bool

func setSplashColors(r, g, b uint8) {
	// texto claro em fundo escuro e vice-versa (luminância aproximada)
	if int(r)*299+int(g)*587+int(b)*114 < 128000 {
		splashFG = 0x00B8B8B8
	} else {
		splashFG = 0x00505050
	}
}

type paintStruct struct {
	hdc         uintptr
	fErase      int32
	rcPaint     [4]int32
	fRestore    int32
	fIncUpdate  int32
	rgbReserved [32]byte
}

// paintSplash desenha o texto no centro. Depois que o WebView2 se instala,
// ele cobre a área inteira e isto deixa de aparecer.
func paintSplash(hwnd uintptr) {
	var ps paintStruct
	hdc, _, _ := procBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	if hdc == 0 {
		return
	}
	defer procEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	var rc [4]int32
	_, _, _ = procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&rc)))
	face, _ := windows.UTF16PtrFromString("Segoe UI")
	font, _, _ := procCreateFontW.Call(^uintptr(19) /* -20 px */, 0, 0, 0, 400, 0, 0, 0, 1 /* DEFAULT_CHARSET */, 0, 0, 5 /* CLEARTYPE */, 0, uintptr(unsafe.Pointer(face)))
	if font != 0 {
		old, _, _ := procSelectObject.Call(hdc, font)
		defer func() {
			_, _, _ = procSelectObject.Call(hdc, old)
			_, _, _ = procDeleteObject.Call(font)
		}()
	}
	_, _, _ = procSetBkMode.Call(hdc, 1 /* TRANSPARENT */)
	_, _, _ = procSetTextColor.Call(hdc, uintptr(splashFG))
	text, _ := windows.UTF16FromString("Abrindo " + windowTitle + "…")
	const dtFlags = 0x1 /* CENTER */ | 0x4 /* VCENTER */ | 0x20 /* SINGLELINE */
	_, _, _ = procDrawTextW.Call(hdc, uintptr(unsafe.Pointer(&text[0])), uintptr(len(text)-1), uintptr(unsafe.Pointer(&rc)), dtFlags)
}
