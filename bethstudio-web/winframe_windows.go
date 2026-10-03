//go:build windows

package main

// winframe_windows.go — janela sem a barra de titulo nativa: a barra de abas
// da pagina faz esse papel (como o Windows Terminal).
//
//   - O estilo continua WS_OVERLAPPEDWINDOW (Aero Snap, sombra do DWM,
//     animacoes de minimizar/maximizar, arrastar entre monitores e maximizar
//     respeitando a barra de tarefas ficam com o Windows). So' o topo sai:
//     WM_NCCALCSIZE devolve a area cliente com o topo original (sem caption
//     nem borda de cima); as bordas laterais/de baixo continuam nao-cliente
//     (invisiveis no Windows 10/11) e redimensionam como sempre.
//   - Maximizado, a janela passa da tela pela espessura da borda: o topo da
//     area cliente desce essa espessura para nada ficar cortado.
//   - A pagina (WebView2 cobre a area cliente inteira) pede as acoes por
//     window.chrome.webview.postMessage("win:..."): arrastar (HTCAPTION),
//     redimensionar pelo topo (HTTOP/HTTOPLEFT/HTTOPRIGHT), minimizar,
//     maximizar/restaurar e fechar (o mesmo WM_CLOSE de antes). O arraste e'
//     feito pelo Go (ReleaseCapture + WM_NCLBUTTONDOWN), que funciona em
//     qualquer versao do runtime do WebView2.
//   - O Go avisa a pagina do estado (maximizada, ativa) via
//     window.__bethstudioWin(max, active).
//   - Snap Layouts do Windows 11 no botao maximizar precisam de HTMAXBUTTON
//     numa regiao nao-cliente; com o WebView2 cobrindo tudo isso exigiria a
//     API de regioes nao-cliente do WebView2 (app-region), ainda nao usada.

import (
	"fmt"
	"unsafe"
)

var (
	procIsZoomed       = user32.NewProc("IsZoomed")
	procReleaseCapture = user32.NewProc("ReleaseCapture")
	procPostMessageW   = user32.NewProc("PostMessageW")
	procSetWindowPos   = user32.NewProc("SetWindowPos")
)

const (
	wmClose         = 0x0010
	wmNCCalcSize    = 0x0083
	wmNCLButtonDown = 0x00A1
	htCaption       = 2
	htTop           = 12
	htTopLeft       = 13
	htTopRight      = 14
	swMinimize      = 6
	swMaximize      = 3
	swRestore       = 9
	smCyFrame       = 33
	smCxPadded      = 92
	swpFrameChanged = 0x0020
	swpNoSizeMove   = 0x0001 | 0x0002 | 0x0004 // NOSIZE|NOMOVE|NOZORDER
)

type winRect struct{ Left, Top, Right, Bottom int32 }

type ncCalcSizeParams struct {
	Rgrc  [3]winRect
	Lppos uintptr
}

var (
	hostHwnd   uintptr
	hostActive = true
)

// frameCalcSize: WM_NCCALCSIZE sem caption (ver o comentario do arquivo).
func frameCalcSize(hwnd, wp, lp uintptr) (uintptr, bool) {
	if wp == 0 {
		return 0, false
	}
	p := (*ncCalcSizeParams)(unsafe.Pointer(lp))
	top := p.Rgrc[0].Top
	r, _, _ := procDefWindowProcW.Call(hwnd, wmNCCalcSize, wp, lp)
	p.Rgrc[0].Top = top
	if isZoomed(hwnd) {
		fy, _, _ := procGetSystemMetrics.Call(smCyFrame)
		pad, _, _ := procGetSystemMetrics.Call(smCxPadded)
		p.Rgrc[0].Top += int32(fy + pad)
	}
	return r, true
}

func isZoomed(hwnd uintptr) bool {
	r, _, _ := procIsZoomed.Call(hwnd)
	return r != 0
}

// applyFrame recalcula a moldura logo depois de criar a janela.
func applyFrame(hwnd uintptr) {
	hostHwnd = hwnd
	_, _, _ = procSetWindowPos.Call(hwnd, 0, 0, 0, 0, 0, swpFrameChanged|swpNoSizeMove)
}

// windowCommand: mensagens da pagina ("win:...").
func windowCommand(msg string) {
	h := hostHwnd
	if h == 0 {
		return
	}
	hit := uintptr(0)
	switch msg {
	case "win:drag":
		hit = htCaption
	case "win:resize:top":
		hit = htTop
	case "win:resize:topleft":
		hit = htTopLeft
	case "win:resize:topright":
		hit = htTopRight
	case "win:min":
		_, _, _ = procShowWindow.Call(h, swMinimize)
	case "win:toggle":
		if isZoomed(h) {
			_, _, _ = procShowWindow.Call(h, swRestore)
		} else {
			_, _, _ = procShowWindow.Call(h, swMaximize)
		}
	case "win:close":
		_, _, _ = procPostMessageW.Call(h, wmClose, 0, 0)
	case "win:state":
		pushWinState()
	}
	if hit != 0 {
		_, _, _ = procReleaseCapture.Call()
		_, _, _ = procPostMessageW.Call(h, wmNCLButtonDown, hit, 0)
	}
}

// pushWinState avisa a pagina (maximizada? ativa?).
func pushWinState() {
	if hostChromium == nil || hostHwnd == 0 {
		return
	}
	hostChromium.Eval(fmt.Sprintf("window.__bethstudioWin&&window.__bethstudioWin(%v,%v)", isZoomed(hostHwnd), hostActive))
}

// frameInitScript roda antes da pagina: marca a janela sem moldura.
const frameInitScript = "window.__bethstudioFrameless=true;"
