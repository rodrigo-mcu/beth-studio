//go:build windows

package main

// webview_zoom_windows.go — zoom da tela inteira (Ctrl + roda, Ctrl +/-).
//
// O WebView2 guarda o zoom e o devolve na próxima abertura, e nada na tela
// avisava que ele estava diferente de 100%. A página pergunta ("zoom:get",
// quando a janela muda de tamanho) e o Go responde por
// window.__bethstudioZoom(fator); "zoom:reset" volta a 100%.
//
// ICoreWebView2Controller: get_ZoomFactor = 7, put_ZoomFactor = 8 (IUnknown
// 0-2, IsVisible 3-4, Bounds 5-6). O double de put_ZoomFactor vai nos registros
// inteiros e também nos XMM: o syscall do Go copia os 4 primeiros argumentos
// para os dois (convenção x64 do Windows).

import (
	"fmt"
	"math"
	"unsafe"
)

const (
	ctlGetZoomFactor = 7
	ctlPutZoomFactor = 8
)

// zoomCommand trata as mensagens "zoom:..." da página; false se não for uma.
func zoomCommand(msg string) bool {
	switch msg {
	case "zoom:get":
		pushZoom()
	case "zoom:reset":
		if setZoomFactor(1) {
			pushZoom()
		}
	default:
		return false
	}
	return true
}

func zoomController() uintptr {
	if hostChromium == nil {
		return 0
	}
	return uintptr(unsafe.Pointer(hostChromium.GetController()))
}

func getZoomFactor() (float64, bool) {
	c := zoomController()
	if c == 0 {
		return 1, false
	}
	var f float64
	if comCall(c, ctlGetZoomFactor, uintptr(unsafe.Pointer(&f))) != 0 || f <= 0 {
		return 1, false
	}
	return f, true
}

func setZoomFactor(f float64) bool {
	c := zoomController()
	if c == 0 {
		return false
	}
	return comCall(c, ctlPutZoomFactor, uintptr(math.Float64bits(f))) == 0
}

func zoomScript(f float64) string {
	return fmt.Sprintf("window.__bethstudioZoom&&window.__bethstudioZoom(%.4f)", f)
}

// pushZoom avisa a página do zoom atual.
func pushZoom() {
	if f, ok := getZoomFactor(); ok {
		hostChromium.Eval(zoomScript(f))
	}
}
