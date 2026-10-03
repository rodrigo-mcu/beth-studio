//go:build windows

package main

import (
	"os"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Win32 UI (WebView2 window, message box) must stay on the thread that
// created it: lock the main goroutine to the main OS thread.
func init() { runtime.LockOSThread() }

// stdioOK is true when stdout/stderr point somewhere (a redirect, a pipe or
// the parent console). A windowsgui exe launched by a double click has none.
var stdioOK bool

var (
	user32          = windows.NewLazySystemDLL("user32.dll")
	procMessageBoxW = user32.NewProc("MessageBoxW")
	kernel32        = windows.NewLazySystemDLL("kernel32.dll")
	procAttachCons  = kernel32.NewProc("AttachConsole")
)

func messageBox(title, text string) {
	t, _ := syscall.UTF16PtrFromString(title)
	m, _ := syscall.UTF16PtrFromString(text)
	const mbIconError = 0x10
	_, _, _ = procMessageBoxW.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), mbIconError)
}

// attachParentConsole: the exe is built with -H windowsgui, so when started
// from cmd/PowerShell without redirection it has no stdout. Attach to the
// parent's console so `--no-window` can print the URL there.
func attachParentConsole() {
	if h, err := windows.GetStdHandle(windows.STD_OUTPUT_HANDLE); err == nil && h != 0 && h != windows.InvalidHandle {
		if _, err := windows.GetFileType(h); err == nil {
			stdioOK = true
			return
		}
	}
	const attachParentProcess = ^uintptr(0) // (DWORD)-1
	if r, _, _ := procAttachCons.Call(attachParentProcess); r == 0 {
		return
	}
	if f, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0); err == nil {
		os.Stdout = f
		os.Stderr = f
		stdioOK = true
	}
}

// hideChildWindow: the bridge is a console exe; without CREATE_NO_WINDOW a
// windowsgui parent would flash a console window for it.
func hideChildWindow(attr **syscall.SysProcAttr) {
	*attr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windows.CREATE_NO_WINDOW,
	}
}
