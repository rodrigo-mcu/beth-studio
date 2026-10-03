//go:build windows

package main

// tray_windows.go — o ícone do Studio no relógio. Roda numa thread própria
// com laço de mensagens (a thread principal é da janela do WebView2). O menu
// vem de tray_model.go; aqui só ficam as chamadas Win32 e as ações.

import (
	"context"
	"fmt"
	"log"
	"os"
	"runtime"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	trayShell32          = windows.NewLazySystemDLL("shell32.dll")
	trayProcNotify       = trayShell32.NewProc("Shell_NotifyIconW")
	trayProcCreatePopup  = user32.NewProc("CreatePopupMenu")
	trayProcAppendMenu   = user32.NewProc("AppendMenuW")
	trayProcTrackPopup   = user32.NewProc("TrackPopupMenuEx")
	trayProcDestroyMenu  = user32.NewProc("DestroyMenu")
	trayProcDefaultItem  = user32.NewProc("SetMenuDefaultItem")
	trayProcRegisterMsg  = user32.NewProc("RegisterWindowMessageW")
	trayProcSetTimer     = user32.NewProc("SetTimer")
	trayProcMessageBox   = user32.NewProc("MessageBoxW")
	trayProcGetIconInfo  = user32.NewProc("GetIconInfo")
	trayProcCreateIcon   = user32.NewProc("CreateIconIndirect")
	trayProcDestroyIcon  = user32.NewProc("DestroyIcon")
	trayProcGetObject    = gdi32.NewProc("GetObjectW")
	trayProcGetDIBits    = gdi32.NewProc("GetDIBits")
	trayProcSetDIBits    = gdi32.NewProc("SetDIBits")
	trayProcCreateDC     = gdi32.NewProc("CreateCompatibleDC")
	trayProcDeleteDC     = gdi32.NewProc("DeleteDC")
	trayProcDeleteObject = gdi32.NewProc("DeleteObject")
)

const (
	wmTrayMsg    = 0x8000 + 1 // WM_APP + 1
	wmTimerTray  = 0x0113
	wmNullTray   = 0x0000
	wmLButtonUpT = 0x0202
	wmRButtonUpT = 0x0205

	nimAdd    = 0
	nimModify = 1
	nimDelete = 2
	nifMsg    = 0x1
	nifIcon   = 0x2
	nifTip    = 0x4

	tpmReturnCmd = 0x100
	tpmNoNotify  = 0x80

	mfStringT    = 0x0
	mfGrayedT    = 0x1
	mfPopupT     = 0x10
	mfSeparatorT = 0x800

	mbYesNo       = 0x4
	mbIconWarning = 0x30
	mbDefButton2  = 0x100
	mbSetFg       = 0x10000
	mbTopmost     = 0x40000
	idYesT        = 6

	swHide = 0

	timerRefresh = 1
	timerWatch   = 2
)

type notifyIconData struct {
	CbSize           uint32
	HWnd             uintptr
	UID              uint32
	UFlags           uint32
	UCallbackMessage uint32
	HIcon            uintptr
	SzTip            [128]uint16
	DwState          uint32
	DwStateMask      uint32
	SzInfo           [256]uint16
	UVersion         uint32
	SzInfoTitle      [64]uint16
	DwInfoFlags      uint32
	GuidItem         windows.GUID
	HBalloonIcon     uintptr
}

type trayEnv struct {
	hub *hub
	sup *supervisor
	ctl hostCtl
}

var (
	trayCtx          trayEnv
	trayHwnd         uintptr
	trayIcon         uintptr
	trayIconWaiting  uintptr
	trayCreatedMsg   uint32
	trayLastTip      string
	trayLastWaiting  = -1
	trayDone         = make(chan struct{})
	trayStarted      atomic.Bool
	trayWndProcAlive = windows.NewCallback(trayWndProc)
)

// runTrayWhenFree sobe a bandeja quando não há uma GUI antiga cuidando dela
// (evita dois ícones); se a GUI estiver rodando, espera e assume quando ela sair.
func runTrayWhenFree(ctx context.Context, h *hub, sup *supervisor, ctl hostCtl) {
	for {
		if ctx.Err() != nil {
			return
		}
		if !ctl.GUIRunning() {
			trayCtx = trayEnv{hub: h, sup: sup, ctl: ctl}
			runTray()
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}

// stopTray tira o ícone e encerra o laço da bandeja (chamado na saída do Studio).
func stopTray() {
	if !trayStarted.Load() || trayHwnd == 0 {
		return
	}
	_, _, _ = procPostMessageW.Call(trayHwnd, wmClose, 0, 0)
	select {
	case <-trayDone:
	case <-time.After(time.Second):
	}
}

// showStudioWindow mostra (e traz para a frente) a janela principal, mesmo
// escondida na bandeja.
func showStudioWindow() {
	if hostHWND != 0 {
		allowForeground()
		bringToFront(hostHWND)
	}
}

// quitStudio fecha o Studio de verdade (os terminais e o host continuam).
func quitStudio() {
	quitRequested.Store(true)
	if hostHWND != 0 {
		_, _, _ = procPostMessageW.Call(hostHWND, wmClose, 0, 0)
		return
	}
	os.Exit(0) // sem janela (testes com --no-window)
}

func runTray() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(trayDone)

	var inst windows.Handle
	_ = windows.GetModuleHandleEx(0, nil, &inst)
	trayIcon = loadAppIcon(inst, smCxSmIcon)
	trayIconWaiting = makeAmberIcon(trayIcon)

	className, _ := windows.UTF16PtrFromString("BethStudioTray")
	wc := wndClassEx{WndProc: trayWndProcAlive, Instance: inst, ClassName: className}
	wc.Size = uint32(unsafe.Sizeof(wc))
	if a, _, e := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); a == 0 {
		log.Printf("tray: RegisterClassEx: %v", e)
		return
	}
	hwndMessage := ^uintptr(2) // HWND_MESSAGE = -3
	title, _ := windows.UTF16PtrFromString("Beth Studio (bandeja)")
	hwnd, _, e := procCreateWindowExW.Call(0, uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(title)),
		0, 0, 0, 0, 0, hwndMessage, 0, uintptr(inst), 0)
	if hwnd == 0 {
		log.Printf("tray: CreateWindowEx: %v", e)
		return
	}
	trayHwnd = hwnd
	name, _ := windows.UTF16PtrFromString("TaskbarCreated")
	m, _, _ := trayProcRegisterMsg.Call(uintptr(unsafe.Pointer(name)))
	trayCreatedMsg = uint32(m)
	trayStarted.Store(true)

	trayNotify(nimAdd, trayIcon, "Beth Studio")
	trayActive.Store(true)
	trayProcSetTimer.Call(hwnd, timerRefresh, 2000, 0)
	trayProcSetTimer.Call(hwnd, timerWatch, 30000, 0)
	log.Printf("tray: ícone do Studio na bandeja")
	lifeLog("bandeja do Studio iniciada")

	var msg winMsg
	for {
		got, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if int32(got) <= 0 {
			break
		}
		_, _, _ = procTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
		_, _, _ = procDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
	}
	trayActive.Store(false)
}

// trayNotify adiciona ou atualiza o ícone; devolve false se o Windows recusou.
func trayNotify(op uintptr, icon uintptr, tip string) bool {
	var nid notifyIconData
	nid.CbSize = uint32(unsafe.Sizeof(nid))
	nid.HWnd = trayHwnd
	nid.UID = 1
	nid.UFlags = nifMsg | nifIcon | nifTip
	nid.UCallbackMessage = wmTrayMsg
	nid.HIcon = icon
	for i, ch := range windows.StringToUTF16(tip) {
		if i >= len(nid.SzTip)-1 {
			break
		}
		nid.SzTip[i] = ch
	}
	r, _, _ := trayProcNotify.Call(op, uintptr(unsafe.Pointer(&nid)))
	return r != 0
}

func trayWndProc(hwnd, msg, wp, lp uintptr) uintptr {
	switch {
	case trayCreatedMsg != 0 && uint32(msg) == trayCreatedMsg:
		// o Explorer reiniciou: o ícone sumiu, põe de novo
		trayLastTip, trayLastWaiting = "", -1
		trayNotify(nimAdd, trayIcon, "Beth Studio")
		refreshTray()
		return 0
	case msg == wmTrayMsg:
		switch lp & 0xFFFF {
		case wmLButtonUpT:
			showStudioWindow()
		case wmRButtonUpT:
			showTrayMenu()
		}
		return 0
	case msg == wmTimerTray:
		switch wp {
		case timerRefresh:
			refreshTray()
		case timerWatch:
			// o Windows às vezes descarta o ícone sem avisar: modifica e, se falhar, adiciona
			if !trayNotify(nimModify, trayIcon, trayLastTip) {
				trayLastTip, trayLastWaiting = "", -1
				trayNotify(nimAdd, trayIcon, "Beth Studio")
				refreshTray()
			}
		}
		return 0
	case msg == wmClose:
		trayNotify(nimDelete, trayIcon, "")
		_, _, _ = procDestroyWindow.Call(hwnd)
		return 0
	case msg == wmDestroy:
		_, _, _ = procPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := procDefWindowProcW.Call(hwnd, msg, wp, lp)
	return r
}

// refreshTray atualiza a dica e o ícone (âmbar quando algum agente espera).
func refreshTray() {
	if trayCtx.hub == nil || trayCtx.sup == nil {
		return
	}
	panes, waiting := trayCtx.hub.trayStats()
	st, _ := trayCtx.sup.State()
	tip := trayTooltip(panes, waiting, st)
	w := 0
	icon := trayIcon
	if waiting > 0 {
		w = 1
		icon = trayIconWaiting
	}
	if tip == trayLastTip && w == trayLastWaiting {
		return
	}
	if trayNotify(nimModify, icon, tip) {
		trayLastTip, trayLastWaiting = tip, w
	}
}

func buildTrayMenu(items []trayItem) (menu uintptr, defID int) {
	menu, _, _ = trayProcCreatePopup.Call()
	for _, it := range items {
		switch {
		case it.Sep:
			trayProcAppendMenu.Call(menu, mfSeparatorT, 0, 0)
		case it.Sub != nil:
			sub, _ := buildTrayMenu(it.Sub)
			text, _ := windows.UTF16PtrFromString(it.Label)
			flags := uintptr(mfStringT | mfPopupT)
			if it.Grayed {
				flags |= mfGrayedT
			}
			trayProcAppendMenu.Call(menu, flags, sub, uintptr(unsafe.Pointer(text)))
		default:
			text, _ := windows.UTF16PtrFromString(it.Label)
			flags := uintptr(mfStringT)
			if it.Grayed {
				flags |= mfGrayedT
			}
			trayProcAppendMenu.Call(menu, flags, uintptr(it.ID), uintptr(unsafe.Pointer(text)))
			if it.Default {
				defID = it.ID
			}
		}
	}
	if defID != 0 {
		trayProcDefaultItem.Call(menu, uintptr(defID), 0)
	}
	return menu, defID
}

func showTrayMenu() {
	items := trayMenu(trayCtx.hub.trayShellList(), trayCtx.ctl.Running())
	menu, _ := buildTrayMenu(items)
	if menu == 0 {
		return
	}
	var pt winPoint
	_, _, _ = procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	_, _, _ = procSetForegroundWindow.Call(trayHwnd)
	cmd, _, _ := trayProcTrackPopup.Call(menu, tpmReturnCmd|tpmNoNotify, uintptr(pt.X), uintptr(pt.Y), trayHwnd, 0)
	_, _, _ = procPostMessageW.Call(trayHwnd, wmNullTray, 0, 0)
	trayProcDestroyMenu.Call(menu)
	if cmd != 0 {
		handleTrayCommand(int(cmd))
	}
}

func handleTrayCommand(id int) {
	switch {
	case id == trayOpen:
		showStudioWindow()
	case id == trayTasks:
		showStudioWindow()
		trayCtx.hub.broadcast(map[string]any{"ev": "ui_open", "what": "tasks"})
	case id == trayQuitTray:
		lifeLog("saindo da bandeja; o host e os terminais continuam")
		quitStudio()
	case id == trayKillAll:
		confirmKillAll()
	case id >= trayShellBase:
		shells := trayCtx.hub.trayShellList()
		if i := id - trayShellBase; i >= 0 && i < len(shells) {
			if err := trayCtx.hub.spawnShell(shells[i].ID); err != nil {
				log.Printf("tray: novo terminal: %v", err)
				return
			}
			showStudioWindow()
		}
	}
}

// confirmKillAll: "Encerrar tudo" só acontece depois de o usuário dizer Sim.
func confirmKillAll() {
	panes, _ := trayCtx.hub.trayStats()
	what := fmt.Sprintf("fechar %d terminais", panes)
	if panes == 1 {
		what = "fechar 1 terminal"
	} else if panes == 0 {
		what = "encerrar o host"
	}
	text, _ := windows.UTF16PtrFromString(fmt.Sprintf(
		"Encerrar o Beth Studio e %s?\n\nShells, agentes e sessões WSL abertos serão fechados. Isso não pode ser desfeito.", what))
	title, _ := windows.UTF16PtrFromString("Encerrar tudo")
	r, _, _ := trayProcMessageBox.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)),
		mbYesNo|mbIconWarning|mbDefButton2|mbSetFg|mbTopmost)
	if r != idYesT {
		return
	}
	lifeLog("Encerrar tudo confirmado pelo usuário na bandeja do Studio")
	trayCtx.sup.AskQuit()
	if err := trayCtx.ctl.RequestQuit("Studio — Encerrar tudo (confirmado pelo usuário)"); err != nil {
		log.Printf("tray: encerrar o host: %v", err)
		lifeLog("falha ao encerrar o host: " + err.Error())
	}
	quitStudio()
}

// --- ícone com a marca âmbar --------------------------------------------------

type iconInfoT struct {
	FIcon    uint32
	XHotspot uint32
	YHotspot uint32
	HbmMask  uintptr
	HbmColor uintptr
}

type bitmapT struct {
	BmType       int32
	BmWidth      int32
	BmHeight     int32
	BmWidthBytes int32
	BmPlanes     uint16
	BmBitsPixel  uint16
	BmBits       uintptr
}

type bitmapInfoHeader struct {
	Size          uint32
	Width, Height int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPels, YPels  int32
	ClrUsed       uint32
	ClrImportant  uint32
}

// makeAmberIcon copia o ícone e pinta uma bolinha âmbar no canto inferior
// direito (agente aguardando). Se algo falhar, devolve o ícone original.
func makeAmberIcon(base uintptr) uintptr {
	if base == 0 {
		return base
	}
	var ii iconInfoT
	if r, _, _ := trayProcGetIconInfo.Call(base, uintptr(unsafe.Pointer(&ii))); r == 0 {
		return base
	}
	defer func() {
		trayProcDeleteObject.Call(ii.HbmColor)
		trayProcDeleteObject.Call(ii.HbmMask)
	}()
	var bm bitmapT
	if r, _, _ := trayProcGetObject.Call(ii.HbmColor, unsafe.Sizeof(bm), uintptr(unsafe.Pointer(&bm))); r == 0 {
		return base
	}
	w, h := int(bm.BmWidth), int(bm.BmHeight)
	if w < 8 || h < 8 {
		return base
	}
	hdc, _, _ := trayProcCreateDC.Call(0)
	if hdc == 0 {
		return base
	}
	defer trayProcDeleteDC.Call(hdc)
	hdr := bitmapInfoHeader{Width: int32(w), Height: -int32(h), Planes: 1, BitCount: 32}
	hdr.Size = uint32(unsafe.Sizeof(hdr))
	pixels := make([]byte, w*h*4)
	if r, _, _ := trayProcGetDIBits.Call(hdc, ii.HbmColor, 0, uintptr(h), uintptr(unsafe.Pointer(&pixels[0])), uintptr(unsafe.Pointer(&hdr)), 0); r == 0 {
		return base
	}
	paintAmberDot(pixels, w, h)
	if r, _, _ := trayProcSetDIBits.Call(hdc, ii.HbmColor, 0, uintptr(h), uintptr(unsafe.Pointer(&pixels[0])), uintptr(unsafe.Pointer(&hdr)), 0); r == 0 {
		return base
	}
	ii.FIcon = 1
	out, _, _ := trayProcCreateIcon.Call(uintptr(unsafe.Pointer(&ii)))
	if out == 0 {
		return base
	}
	return out
}

// paintAmberDot desenha o disco âmbar com um anel branco fino (BGRA, de cima para baixo).
func paintAmberDot(pixels []byte, w, h int) {
	r := w * 3 / 10
	if r < 3 {
		r = 3
	}
	cx, cy := w-r-1, h-r-1
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			dx, dy := x-cx, y-cy
			d2 := dx*dx + dy*dy
			var b, g, rr byte
			switch {
			case d2 <= r*r:
				b, g, rr = 0x0B, 0x9E, 0xF5 // âmbar #F59E0B
			case d2 <= (r+1)*(r+1):
				b, g, rr = 0xFF, 0xFF, 0xFF
			default:
				continue
			}
			i := (y*w + x) * 4
			pixels[i], pixels[i+1], pixels[i+2], pixels[i+3] = b, g, rr, 0xFF
		}
	}
}
