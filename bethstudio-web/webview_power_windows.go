//go:build windows

package main

// webview_power_windows.go — WebView2 em segundo plano gasta menos.
//
// Fechar a janela principal so' a esconde (bandeja), e minimizar tambem a
// tira da vista, mas o WebView2 seguia "visivel" para o Chromium: com o
// notebook lento isso mantem renderizacao e memoria cheias a toa.
//
// Em segundo plano:
//   - IsVisible=false (o Chromium para de pintar e reduz o trabalho);
//   - MemoryUsageTargetLevel=Low (ICoreWebView2_19): o Chromium devolve memoria.
// Ao voltar, tudo volta ao normal.
//
// De proposito NAO usamos TrySuspend: ele pausa scripts e timers da pagina, e e'
// a pagina que dispara avisos (agente terminou etc.) com a janela escondida.
//
// Desligar: BETHSTUDIO_WEBVIEW_NO_BG=1.
//
// ICoreWebView2_19 (WebView2.h, SDK com 121 metodos na vtable):
//   QueryInterface=0 ... get_MemoryUsageTargetLevel=119, put_MemoryUsageTargetLevel=120.
//   COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL: NORMAL=0, LOW=1.

import (
	"log"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	wmShowWindow    = 0x0018
	sizeMinimized   = 1
	iidWebView2_19  = "{6921F954-79B0-437F-A997-C85811897C68}"
	vtPutMemTarget  = 120
	memTargetNormal = 0
	memTargetLow    = 1
)

var (
	webviewInBackground bool
	webview19           uintptr // ICoreWebView2_19 (0 = runtime antigo, sem a interface)
	webview19Tried      bool
)

// webviewVisibilityFor diz se esta mensagem da janela a colocou em segundo
// plano (background=true) ou de volta a' vista; ok=false se nao e' sobre isso.
func webviewVisibilityFor(msg uint32, wp uintptr) (background, ok bool) {
	switch msg {
	case wmShowWindow:
		return wp == 0, true // wParam: TRUE = sendo mostrada, FALSE = escondida
	case wmSize:
		return wp == sizeMinimized, true
	}
	return false, false
}

// setWebviewBackground: chamar na thread da janela (hostWndProc).
func setWebviewBackground(bg bool) {
	if hostChromium == nil || bg == webviewInBackground || os.Getenv("BETHSTUDIO_WEBVIEW_NO_BG") == "1" {
		return
	}
	webviewInBackground = bg
	if bg {
		setWebviewMemoryTarget(memTargetLow)
		_ = hostChromium.Hide()
	} else {
		_ = hostChromium.Show()
		setWebviewMemoryTarget(memTargetNormal)
	}
	log.Printf("webview: segundo plano=%v", bg)
}

func setWebviewMemoryTarget(level uintptr) {
	if !webview19Tried {
		webview19Tried = true
		if wv := hostChromium.GetICoreWebView2_3(); wv != nil {
			if guid, err := windows.GUIDFromString(iidWebView2_19); err == nil {
				var out uintptr
				// HRESULT 0 = S_OK; runtime sem ICoreWebView2_19 devolve E_NOINTERFACE
				if hr := comCall(uintptr(unsafe.Pointer(wv)), 0, uintptr(unsafe.Pointer(&guid)), uintptr(unsafe.Pointer(&out))); uint32(hr) == 0 {
					webview19 = out // fica ate' o processo acabar
				}
			}
		}
		if webview19 == 0 {
			log.Printf("webview: runtime sem ICoreWebView2_19; so' IsVisible")
		}
	}
	if webview19 != 0 {
		comCall(webview19, vtPutMemTarget, level)
	}
}
