//go:build windows

package main

// A janela Banco de dados é um processo à parte, com botão próprio na barra
// de tarefas. O Studio só pede para abrir (ou trazer para a frente). Não
// sobe ponte com o host.

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	dbWindowTitle = "Banco de dados"
	dbWindowClass = "BethStudioWeb"
	dbWindowMutex = "Local\\BethStudioDbWindow"
	dbAppUserID   = "BethStudio.Database"
)

// dbStandalone: este processo é a janela do banco, não o Studio.
var dbStandalone bool

var (
	procFindWindowW = user32.NewProc("FindWindowW")
	procIsIconicW   = user32.NewProc("IsIconic")
	procSetAppID    = windows.NewLazySystemDLL("shell32.dll").NewProc("SetCurrentProcessExplicitAppUserModelID")
)

func openDBWindow() error {
	if focusDBWindow() {
		return nil
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(self); err == nil {
		self = resolved
	}
	cmd := exec.Command(self, "--db")
	cmd.Dir = filepath.Dir(self)
	allowForeground()
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x08000000 | 0x00000008 | 0x00000200, // CREATE_NO_WINDOW | DETACHED | NEW_GROUP
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("não foi possível abrir a janela do banco: %w", err)
	}
	go func() { _ = cmd.Wait() }()
	log.Printf("db: janela aberta (pid %d)", cmd.Process.Pid)
	return nil
}

func focusDBWindow() bool {
	class, _ := windows.UTF16PtrFromString(dbWindowClass)
	title, _ := windows.UTF16PtrFromString(dbWindowTitle)
	hwnd, _, _ := procFindWindowW.Call(uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(title)))
	if hwnd == 0 {
		return false
	}
	if iconic, _, _ := procIsIconicW.Call(hwnd); iconic != 0 {
		_, _, _ = procShowWindow.Call(hwnd, 9) // SW_RESTORE
	} else {
		_, _, _ = procShowWindow.Call(hwnd, swShow)
	}
	_, _, _ = procSetForegroundWindow.Call(hwnd)
	return true
}

func runDBMode(noWindow, devtools bool, port int, winSize, devOrig string) {
	dbStandalone = true
	name, _ := windows.UTF16PtrFromString(dbWindowMutex)
	_, err := windows.CreateMutex(nil, false, name)
	if err == windows.ERROR_ALREADY_EXISTS {
		focusDBWindow()
		return
	}

	attachParentConsole()
	logClose := setupLog()
	defer logClose()

	settings.load(dataDir())
	secrets.load(dataDir())

	token := randomToken()
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		fatal("não foi possível abrir a porta local: %v", err)
	}
	addr := ln.Addr().(*net.TCPAddr)
	base := fmt.Sprintf("http://127.0.0.1:%d", addr.Port)
	url := fmt.Sprintf("%s/?t=%s&mode=db", base, token)

	hub := newHub(false)
	srv := &http.Server{
		Handler:           newServer(token, addr.Port, devOrig, hub),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("http: %v", err)
		}
	}()

	windowTitle = dbWindowTitle
	webviewDataName = "WebView2-db"
	setDBAppUserModelID()
	log.Printf("bethstudio-web db: em %s", base)
	fmt.Fprintln(os.Stdout, url)

	if noWindow {
		select {}
	}
	w, ht := 1280, 800
	if _, err := fmt.Sscanf(winSize, "%dx%d", &w, &ht); err != nil || w < 800 || ht < 500 {
		w, ht = 1280, 800
	}
	if err := openWindow(url, devtools, w, ht); err != nil {
		messageBox("Beth Studio · "+dbWindowTitle, "Não foi possível abrir a janela (WebView2):\n\n"+err.Error())
	}
	log.Printf("bethstudio-web db: encerrando")
	shutCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutCtx)
}

// setDBAppUserModelID separa o botão da barra de tarefas do botão do Studio.
func setDBAppUserModelID() {
	p, err := windows.UTF16PtrFromString(dbAppUserID)
	if err != nil {
		return
	}
	_, _, _ = procSetAppID.Call(uintptr(unsafe.Pointer(p)))
}
