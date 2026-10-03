//go:build windows

package main

// term_window_windows.go — terminal destacado: um processo
// `bethstudio-web.exe --term <pane>` com janela própria (pode ir para outro
// monitor). Ele NÃO sobe servidor nem ponte: navega para o servidor do
// Studio que o abriu, pela URL/token recebidos por variável de ambiente
// (nunca pela linha de comando). Fechar a janela mata só este processo.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	termEnvURL   = "BETHSTUDIO_TERM_URL"
	termEnvAPI   = "BETHSTUDIO_TERM_API"
	termEnvToken = "BETHSTUDIO_TERM_TOKEN"

	wmMoving       = 0x0216
	wmExitSizeMove = 0x0232
)

var (
	procGetCursorPos   = user32.NewProc("GetCursorPos")
	procScreenToClient = user32.NewProc("ScreenToClient")
)

type winPoint struct{ X, Y int32 }

func termTitle(pane int) string { return fmt.Sprintf("Terminal %d", pane) }

// termWinProc: a janela destacada vista pelo Studio.
type termWinProc struct {
	cmd  *exec.Cmd
	pane int
}

func (t *termWinProc) Kill() { _ = t.cmd.Process.Kill() }

func (t *termWinProc) Focus() {
	class, _ := windows.UTF16PtrFromString("BethStudioWeb")
	title, _ := windows.UTF16PtrFromString(termTitle(t.pane))
	hwnd, _, _ := procFindWindowW.Call(uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(title)))
	if hwnd != 0 {
		bringToFront(hwnd)
	}
}

// launchTermWindow abre a janela destacada do pane (processo filho).
func launchTermWindow(s *server, pane int) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(self); err == nil {
		self = resolved
	}
	cmd := exec.Command(self, "--term", strconv.Itoa(pane))
	cmd.Dir = filepath.Dir(self)
	cmd.Env = append(os.Environ(),
		termEnvURL+"="+fmt.Sprintf("%s/?t=%s&mode=term&pane=%d", s.origin, s.token, pane),
		termEnvAPI+"="+s.origin,
		termEnvToken+"="+s.token,
	)
	allowForeground()
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x08000000 | 0x00000008 | 0x00000200, // CREATE_NO_WINDOW | DETACHED | NEW_GROUP
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("não foi possível abrir a janela do terminal: %w", err)
	}
	if s.hub.term.Add(pane, &termWinProc{cmd: cmd, pane: pane}) {
		_ = cmd.Process.Kill() // outra janela do mesmo pane já existe (corrida)
		return nil
	}
	go func() {
		_ = cmd.Wait()
		s.hub.term.Remove(pane)
	}()
	log.Printf("term: janela do terminal %d aberta (pid %d)", pane, cmd.Process.Pid)
	return nil
}

// studioScreenToClient: pixels de tela -> área cliente da janela do Studio.
// ok=false se a janela está minimizada ou o ponto cai fora dela.
func studioScreenToClient(x, y int) (int, int, bool) {
	h := hostHWND
	if h == 0 {
		return 0, 0, false
	}
	if iconic, _, _ := procIsIconicW.Call(h); iconic != 0 {
		return 0, 0, false
	}
	pt := winPoint{int32(x), int32(y)}
	_, _, _ = procScreenToClient.Call(h, uintptr(unsafe.Pointer(&pt)))
	var rc winRect
	_, _, _ = procGetClientRect.Call(h, uintptr(unsafe.Pointer(&rc)))
	if pt.X < rc.Left || pt.Y < rc.Top || pt.X >= rc.Right || pt.Y >= rc.Bottom {
		return 0, 0, false
	}
	return int(pt.X), int(pt.Y), true
}

// --- processo da janela (--term) --------------------------------------------

var (
	termAPI, termToken string
	termPaneID         int
	termMoving         bool
	termDragCh         = make(chan termReq, 8)
	termLastSent       time.Time
)

// termDragHook: chamado pelo hostWndProc (WM_MOVING / WM_EXITSIZEMOVE).
// Avisa o Studio onde está o cursor para ele acender as zonas de soltar.
func termDragHook(end bool) {
	if end && !termMoving {
		return // fim de redimensionamento, não de arrasto
	}
	var pt winPoint
	_, _, _ = procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	req := termReq{PaneID: &termPaneID, X: int(pt.X), Y: int(pt.Y), End: end}
	if end {
		termMoving = false
		termDragCh <- req
		return
	}
	termMoving = true
	if time.Since(termLastSent) < 40*time.Millisecond {
		return
	}
	termLastSent = time.Now()
	select {
	case termDragCh <- req:
	default:
	}
}

func termPost(path string, body any) error {
	b, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, termAPI+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(tokenHeader, termToken)
	resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	return resp.Body.Close()
}

// termWatchdog: o Studio sumiu (fechou/caiu) => esta janela não serve mais.
func termWatchdog() {
	fails := 0
	for range time.Tick(3 * time.Second) {
		req, _ := http.NewRequest(http.MethodGet, termAPI+"/healthz", nil)
		req.Header.Set(tokenHeader, termToken)
		resp, err := (&http.Client{Timeout: 2 * time.Second}).Do(req)
		if err == nil {
			_ = resp.Body.Close()
			fails = 0
			continue
		}
		if fails++; fails >= 3 {
			log.Printf("term: Studio não responde, fechando a janela")
			os.Exit(0)
		}
	}
}

func runTermMode(pane int, devtools bool, winSize string) {
	pageURL := os.Getenv(termEnvURL)
	termAPI = os.Getenv(termEnvAPI)
	termToken = os.Getenv(termEnvToken)
	if pageURL == "" || termAPI == "" || termToken == "" {
		fatal("--term só é aberto pelo Studio (faltam URL e token)")
	}
	attachParentConsole()
	logClose := setupLog()
	defer logClose()
	settings.load(dataDir())

	termPaneID = pane
	windowTitle = termTitle(pane)
	webviewDataName = "WebView2-term"
	if p, err := windows.UTF16PtrFromString("BethStudio.Terminal." + strconv.Itoa(pane)); err == nil {
		_, _, _ = procSetAppID.Call(uintptr(unsafe.Pointer(p)))
	}
	termWndHook = termDragHook
	go func() {
		for r := range termDragCh {
			if err := termPost("/api/term/drag", r); err != nil {
				log.Printf("term: drag: %v", err)
			}
		}
	}()
	go termWatchdog()

	w, h := 900, 600
	if _, err := fmt.Sscanf(winSize, "%dx%d", &w, &h); err != nil || w < 400 || h < 300 {
		w, h = 900, 600
	}
	log.Printf("bethstudio-web term: terminal %d", pane)
	if err := openWindow(pageURL, devtools, w, h); err != nil {
		messageBox(appTitle, "Não foi possível abrir a janela (WebView2):\n\n"+err.Error())
	}
}
