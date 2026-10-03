//go:build windows

package main

// webhost_windows.go — janela propria com WebView2 (pkg/edge da
// go-webview2), no lugar do wrapper webview2.NewWithOptions, para:
//
//   - PermissionRequested proprio: o handler da biblioteca le o tipo de
//     permissao com um bug (passa o valor em vez do ponteiro), entao nunca
//     casa. Aqui: microfone e leitura da area de transferencia sao
//     liberados SO' para a nossa origem (http://127.0.0.1:<porta>); camera,
//     localizacao etc. sao negados; o resto fica no padrao.
//   - NavigationStarting: a pagina nunca sai da nossa origem; um link para
//     fora (ex. "Onde pego minha chave?") abre no navegador do sistema.
//   - DefaultBackgroundColor = fundo do tema salvo (sem flash de outra cor).
//
// Vtables COM (ordem do SDK do WebView2, as mesmas de pkg/edge):
//   ICoreWebView2: ...,21 add_ScriptDialogOpening, 22 remove_...,
//     23 add_PermissionRequested; 7 add_NavigationStarting.
//   ICoreWebView2PermissionRequestedEventArgs: 3 get_Uri, 4 get_PermissionKind,
//     5 get_IsUserInitiated, 6 get_State, 7 put_State.
//   ICoreWebView2NavigationStartingEventArgs: 3 get_Uri, ..., 8 put_Cancel.

import (
	"errors"
	"log"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"github.com/jchv/go-webview2/pkg/edge"
	"golang.org/x/sys/windows"
)

var (
	procRegisterClassExW         = user32.NewProc("RegisterClassExW")
	procCreateWindowExW          = user32.NewProc("CreateWindowExW")
	procDefWindowProcW           = user32.NewProc("DefWindowProcW")
	procShowWindow               = user32.NewProc("ShowWindow")
	procSetForegroundWindow      = user32.NewProc("SetForegroundWindow")
	procAllowSetForegroundWindow = user32.NewProc("AllowSetForegroundWindow")
	procUpdateWindow             = user32.NewProc("UpdateWindow")
	procGetMessageW              = user32.NewProc("GetMessageW")
	procTranslateMessage         = user32.NewProc("TranslateMessage")
	procDispatchMessageW         = user32.NewProc("DispatchMessageW")
	procPostQuitMessage          = user32.NewProc("PostQuitMessage")
	procLoadCursorW              = user32.NewProc("LoadCursorW")
	procLoadIconW                = user32.NewProc("LoadIconW")
	procLoadImageW               = user32.NewProc("LoadImageW")
	procSendMessageW             = user32.NewProc("SendMessageW")
	procGetSystemMetrics         = user32.NewProc("GetSystemMetrics")
	procDestroyWindow            = user32.NewProc("DestroyWindow")
	gdi32                        = windows.NewLazySystemDLL("gdi32.dll")
	procCreateSolidBrush         = gdi32.NewProc("CreateSolidBrush")
	ole32                        = windows.NewLazySystemDLL("ole32.dll")
	procCoTaskMemFree            = ole32.NewProc("CoTaskMemFree")
)

// webviewDataName: pasta do perfil WebView2. A janela SFTP usa outra, para
// não disputar o perfil que o Studio já tem aberto.
var webviewDataName = "WebView2"

// termWndHook: só definido na janela de terminal destacada (--term).
var termWndHook func(end bool)

// allowForeground deixa o processo filho (SFTP) trazer a janela para a frente.
// Quem chama precisa ser o processo que está em primeiro plano (o clique do usuário).
func allowForeground() {
	procAllowSetForegroundWindow.Call(asfwAny)
}

const (
	wmDestroy        = 0x0002
	wmSize           = 0x0005
	wmActivate       = 0x0006
	wmSetFocus       = 0x0007
	wmMove           = 0x0003
	wsOverlappedWin  = 0x00CF0000
	cwUseDefault     = 0x80000000
	swShow           = 5
	asfwAny          = ^uintptr(0) // AllowSetForegroundWindow: qualquer processo
	smCxScreen       = 0
	smCyScreen       = 1
	permMicrophone   = 1
	permCamera       = 2
	permGeolocation  = 3
	permClipboard    = 6
	permStateDefault = 0
	permStateAllow   = 1
	permStateDeny    = 2
)

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   windows.Handle
	Icon       windows.Handle
	Cursor     windows.Handle
	Background windows.Handle
	MenuName   *uint16
	ClassName  *uint16
	IconSm     windows.Handle
}

type winMsg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	PtX     int32
	PtY     int32
}

// comHandler: objeto COM minimo (IUnknown + Invoke) implementado em Go.
type comHandler struct {
	vtbl *comHandlerVtbl
	refs int32
}

type comHandlerVtbl struct {
	QueryInterface uintptr
	AddRef         uintptr
	Release        uintptr
	Invoke         uintptr
}

var (
	hostChromium *edge.Chromium
	hostOrigin   string
	// janela principal: dona dos dialogos nativos (Salvar como...)
	hostHWND uintptr
	// mantidos vivos enquanto a janela existe (ponteiros entregues ao COM)
	keepAlive []any
)

func newComHandler(invoke func(sender, args uintptr) uintptr) *comHandler {
	v := &comHandlerVtbl{
		QueryInterface: windows.NewCallback(func(this, riid, out uintptr) uintptr {
			*(*uintptr)(unsafe.Pointer(out)) = this
			return 0
		}),
		AddRef:  windows.NewCallback(func(this uintptr) uintptr { return 1 }),
		Release: windows.NewCallback(func(this uintptr) uintptr { return 1 }),
		Invoke: windows.NewCallback(func(this, sender, args uintptr) uintptr {
			return invoke(sender, args)
		}),
	}
	h := &comHandler{vtbl: v}
	keepAlive = append(keepAlive, v, h)
	return h
}

// comCall chama o metodo `index` da vtable do objeto COM `obj`.
func comCall(obj uintptr, index int, args ...uintptr) uintptr {
	vtbl := *(*uintptr)(unsafe.Pointer(obj))
	fn := *(*uintptr)(unsafe.Pointer(vtbl + uintptr(index)*unsafe.Sizeof(uintptr(0))))
	all := append([]uintptr{obj}, args...)
	r, _, _ := syscall.SyscallN(fn, all...)
	return r
}

func comString(obj uintptr, index int) string {
	var p *uint16
	comCall(obj, index, uintptr(unsafe.Pointer(&p)))
	if p == nil {
		return ""
	}
	s := windows.UTF16PtrToString(p)
	_, _, _ = procCoTaskMemFree.Call(uintptr(unsafe.Pointer(p)))
	return s
}

func sameOrigin(raw, origin string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Scheme+"://"+u.Host, origin)
}

// permissionDecision: a regra, testavel sem WebView2.
func permissionDecision(uri string, kind int, origin string) int {
	ours := sameOrigin(uri, origin)
	switch kind {
	case permMicrophone, permClipboard:
		if ours {
			return permStateAllow
		}
		return permStateDeny
	case permCamera, permGeolocation:
		return permStateDeny
	}
	return permStateDefault
}

func openInSystemBrowser(raw string) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return
	}
	cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", u.String())
	hideChildWindow(&cmd.SysProcAttr)
	_ = cmd.Start()
}

func hostWndProc(hwnd, msg, wp, lp uintptr) uintptr {
	switch msg {
	case wmSize:
		if hostChromium != nil {
			hostChromium.Resize()
			pushWinState()
		}
		return 0
	case wmMove:
		if hostChromium != nil {
			_ = hostChromium.NotifyParentWindowPositionChanged()
		}
	case wmMoving, wmExitSizeMove:
		// janela de terminal destacada: avisa o Studio do arrasto (term_window_windows.go)
		if termWndHook != nil {
			termWndHook(msg == wmExitSizeMove)
		}
	case wmNCCalcSize:
		if r, ok := frameCalcSize(hwnd, wp, lp); ok {
			return r
		}
	case wmActivate, wmSetFocus:
		if msg == wmActivate {
			hostActive = wp&0xFFFF != 0
			pushWinState()
		}
		if hostChromium != nil && (msg == wmSetFocus || wp&0xFFFF != 0) {
			hostChromium.Focus()
		}
	case wmPaint:
		if !webviewReady {
			paintSplash(hwnd) // "Abrindo Beth Studio…" enquanto o WebView2 inicia
			return 0
		}
	case wmClose:
		// Com o ícone na bandeja, fechar a janela principal só a esconde: o Studio
		// segue vigiando o host. "Sair da bandeja" liga quitRequested e fecha de verdade.
		if studioMainWindow && trayActive.Load() && !quitRequested.Load() {
			_, _, _ = procShowWindow.Call(hwnd, swHide)
			return 0
		}
	case wmDestroy:
		_, _, _ = procPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := procDefWindowProcW.Call(hwnd, msg, wp, lp)
	return r
}

// openWindow mostra a UI numa janela WebView2 e bloqueia ate' fechar.
func openWindow(pageURL string, devtools bool, width, height int) error {
	u, err := url.Parse(pageURL)
	if err != nil {
		return err
	}
	hostOrigin = u.Scheme + "://" + u.Host

	dataPath := ""
	if d := appDataDir(); d != "" {
		dataPath = filepath.Join(d, webviewDataName)
		_ = os.MkdirAll(dataPath, 0o755)
	}
	bg := webviewBackground(settings.uiCSS()) // AARRGGBB
	_ = os.Setenv("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", bg)
	var r, g, b uint8
	if len(bg) == 8 {
		var v uint64
		for _, c := range bg[2:] {
			v <<= 4
			switch {
			case c >= '0' && c <= '9':
				v |= uint64(c - '0')
			case c >= 'A' && c <= 'F':
				v |= uint64(c-'A') + 10
			}
		}
		r, g, b = uint8(v>>16), uint8(v>>8), uint8(v)
	}
	setSplashColors(r, g, b)

	var inst windows.Handle
	_ = windows.GetModuleHandleEx(0, nil, &inst)
	className, _ := windows.UTF16PtrFromString("BethTermWeb")
	cursor, _, _ := procLoadCursorW.Call(0, 32512) // IDC_ARROW
	// Icone do BethTerm (recurso #1 do exe: winres/, gerado pelo build.ps1),
	// nos dois tamanhos: barra de titulo (pequeno) e Alt+Tab/barra de
	// tarefas (grande).
	icon := loadAppIcon(inst, smCxIcon)
	iconSm := loadAppIcon(inst, smCxSmIcon)
	brush, _, _ := procCreateSolidBrush.Call(uintptr(r) | uintptr(g)<<8 | uintptr(b)<<16)
	wc := wndClassEx{
		WndProc:    windows.NewCallback(hostWndProc),
		Instance:   inst,
		Icon:       windows.Handle(icon),
		IconSm:     windows.Handle(iconSm),
		Cursor:     windows.Handle(cursor),
		Background: windows.Handle(brush), // janela nativa ja' na cor do tema
		ClassName:  className,
	}
	wc.Size = uint32(unsafe.Sizeof(wc))
	if a, _, e := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); a == 0 {
		return e
	}
	sw, _, _ := procGetSystemMetrics.Call(smCxScreen)
	sh, _, _ := procGetSystemMetrics.Call(smCyScreen)
	x, y := (int(sw)-width)/2, (int(sh)-height)/2
	if x < 0 {
		x = 0
	}
	if y < 0 {
		y = 0
	}
	caption := windowTitle
	if strings.TrimSpace(caption) == "" {
		caption = appTitle
	}
	title, _ := windows.UTF16PtrFromString(caption)
	hwnd, _, e := procCreateWindowExW.Call(0, uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(title)),
		wsOverlappedWin, uintptr(x), uintptr(y), uintptr(width), uintptr(height), 0, 0, uintptr(inst), 0)
	if hwnd == 0 {
		return e
	}
	applyFrame(hwnd) // sem a barra de titulo nativa (winframe_windows.go)
	hostHWND = hwnd
	if icon != 0 {
		_, _, _ = procSendMessageW.Call(hwnd, wmSetIcon, iconBig, icon)
	}
	if iconSm != 0 {
		_, _, _ = procSendMessageW.Call(hwnd, wmSetIcon, iconSmall, iconSm)
	}
	// O primeiro ShowWindow é ignorado quando o processo nasceu com
	// STARTF_USESHOWWINDOW (SW_HIDE). O segundo vale de verdade.
	_, _, _ = procShowWindow.Call(hwnd, swShow)
	_, _, _ = procShowWindow.Call(hwnd, swShow)
	_, _, _ = procSetForegroundWindow.Call(hwnd)
	_, _, _ = procUpdateWindow.Call(hwnd)
	recordStudioWindow(hwnd)
	log.Printf("abertura: janela visível em %s", sinceStart())

	chromium := edge.NewChromium()
	chromium.DataPath = dataPath
	chromium.MessageCallback = windowCommand // "win:..." da barra de titulo da pagina
	hostChromium = chromium
	if !chromium.Embed(hwnd) {
		_, _, _ = procDestroyWindow.Call(hwnd)
		return errors.New("WebView2 não inicializou (runtime ausente?)")
	}
	webviewReady = true
	log.Printf("abertura: WebView2 pronto em %s", sinceStart())
	chromium.Resize()
	if s, err := chromium.GetSettings(); err == nil {
		_ = s.PutAreDefaultContextMenusEnabled(devtools)
		_ = s.PutAreDevToolsEnabled(devtools)
	}
	if c2 := chromium.GetController().GetICoreWebView2Controller2(); c2 != nil {
		_ = c2.PutDefaultBackgroundColor(edge.COREWEBVIEW2_COLOR{A: 255, R: r, G: g, B: b})
	}
	if wv := chromium.GetICoreWebView2_3(); wv != nil {
		obj := uintptr(unsafe.Pointer(wv))
		var token int64
		perm := newComHandler(func(_, args uintptr) uintptr {
			uri := comString(args, 3)
			var kind int32
			comCall(args, 4, uintptr(unsafe.Pointer(&kind)))
			st := permissionDecision(uri, int(kind), hostOrigin)
			if st != permStateDefault {
				comCall(args, 7, uintptr(st))
			}
			log.Printf("webview: permissão %d para %s => %d", kind, uri, st)
			return 0
		})
		comCall(obj, 23, uintptr(unsafe.Pointer(perm)), uintptr(unsafe.Pointer(&token)))
		nav := newComHandler(func(_, args uintptr) uintptr {
			uri := comString(args, 3)
			if uri != "" && !sameOrigin(uri, hostOrigin) && !strings.HasPrefix(uri, "about:") && !strings.HasPrefix(uri, "data:") {
				comCall(args, 8, 1) // put_Cancel(TRUE)
				openInSystemBrowser(uri)
			}
			return 0
		})
		comCall(obj, 7, uintptr(unsafe.Pointer(nav)), uintptr(unsafe.Pointer(&token)))
		// Nunca deixa o WebView2 abrir uma janela nova de verdade (target=_blank,
		// window.open, Ctrl/meio-clique): sempre Handled=TRUE, e so' o navegador
		// do sistema quando o alvo for http(s) (a mesma checagem de
		// openInSystemBrowser). AddNewWindowRequested = indice 44 do vtable
		// (IUnknown 0-2, GetSettings..Stop = 3-43, AddNewWindowRequested = 44).
		newWin := newComHandler(func(_, args uintptr) uintptr {
			uri := comString(args, 3) // get_Uri
			comCall(args, 6, 1)       // put_Handled(TRUE)
			openInSystemBrowser(uri)  // no-op se nao for http(s)
			return 0
		})
		comCall(obj, 44, uintptr(unsafe.Pointer(newWin)), uintptr(unsafe.Pointer(&token)))
	}
	chromium.Init(frameInitScript)
	chromium.Navigate(pageURL)
	chromium.Focus()

	var m winMsg
	for {
		got, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(got) <= 0 {
			break
		}
		_, _, _ = procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		_, _, _ = procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
	hostChromium = nil
	return nil
}

const (
	wmSetIcon  = 0x0080
	iconSmall  = 0
	iconBig    = 1
	smCxIcon   = 11
	smCxSmIcon = 49
	imageIcon  = 1
	lrShared   = 0x8000
	idiAppIcon = 32512
)

// loadAppIcon: icone #1 do exe no tamanho da metrica pedida; sem recurso
// (go run, testes) cai no icone padrao do Windows.
func loadAppIcon(inst windows.Handle, metric uintptr) uintptr {
	size, _, _ := procGetSystemMetrics.Call(metric)
	h, _, _ := procLoadImageW.Call(uintptr(inst), 1, imageIcon, size, size, lrShared)
	if h == 0 {
		h, _, _ = procLoadIconW.Call(0, idiAppIcon)
	}
	return h
}
