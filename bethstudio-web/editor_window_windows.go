//go:build windows

package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func openEditorWindow(path string, edit bool) error {
	if focusEditorWindow(path) {
		return nil
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(self); err == nil {
		self = resolved
	}
	args := []string{"--editor", path}
	if edit {
		args = append(args, "--editor-edit")
	}
	cmd := exec.Command(self, args...)
	cmd.Dir = filepath.Dir(self)
	allowForeground()
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x08000000 | 0x00000008 | 0x00000200, // CREATE_NO_WINDOW | DETACHED | NEW_GROUP
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("não foi possível abrir a janela do editor: %w", err)
	}
	go func() { _ = cmd.Wait() }()
	log.Printf("editor: janela aberta para %s (pid %d)", path, cmd.Process.Pid)
	return nil
}

// focusEditorWindow traz para a frente a janela que já mostra este arquivo.
func focusEditorWindow(path string) bool {
	class, _ := windows.UTF16PtrFromString(dbWindowClass)
	title, _ := windows.UTF16PtrFromString(editorWindowTitle(path))
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

// runEditorMode: processo dedicado só com o editor de um arquivo.
func runEditorMode(path string, edit, devtools bool, port int, winSize, devOrig string) {
	if focusEditorWindow(path) {
		return
	}
	attachParentConsole()
	logClose := setupLog()
	defer logClose()

	settings.load(dataDir())

	token := randomToken()
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		fatal("não foi possível abrir a porta local: %v", err)
	}
	addr := ln.Addr().(*net.TCPAddr)
	base := fmt.Sprintf("http://127.0.0.1:%d", addr.Port)
	q := url.Values{"t": {token}, "mode": {"editor"}, "path": {path}}
	if edit {
		q.Set("edit", "1")
	}
	pageURL := base + "/?" + q.Encode()

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

	windowTitle = editorWindowTitle(path)
	webviewDataName = "WebView2-editor"
	log.Printf("bethstudio-web editor: %s em %s", path, base)

	w, ht := 1000, 760
	if _, err := fmt.Sscanf(winSize, "%dx%d", &w, &ht); err != nil || w < 500 || ht < 360 {
		w, ht = 1000, 760
	}
	if err := openWindow(pageURL, devtools, w, ht); err != nil {
		messageBox("Beth Studio · "+filepath.Base(path), "Não foi possível abrir a janela (WebView2):\n\n"+err.Error())
	}
	log.Printf("bethstudio-web editor: encerrando")
	shutCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutCtx)
}
