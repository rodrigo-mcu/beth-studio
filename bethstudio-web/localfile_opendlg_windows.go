//go:build windows

package main

import (
	"runtime"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procGetOpenFileNameW = comdlg32.NewProc("GetOpenFileNameW")

const ofnFileMustExist = 0x00001000

// openFilter: texto primeiro (o uso normal), depois imagens.
func openFilter() []uint16 {
	parts := []string{
		"Texto e Markdown (*.md, *.txt, *.log)", "*.md;*.markdown;*.txt;*.log",
		"Imagens", "*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp;*.svg",
	}
	var out []uint16
	for _, p := range parts {
		out = append(out, utf16.Encode([]rune(p))...)
		out = append(out, 0)
	}
	return append(out, 0)
}

// nativeOpenDialog mostra o "Abrir" do Windows (dono: a janela do app).
func nativeOpenDialog(initialDir string) (string, bool, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if r, _, _ := procCoInitializeEx.Call(0, 0x2 /* COINIT_APARTMENTTHREADED */); r == 0 || r == 1 {
		defer procCoUninitialize.Call()
	}
	buf := make([]uint16, 32768)
	filter := openFilter()
	title, _ := windows.UTF16PtrFromString("Abrir arquivo")
	var initial *uint16
	if initialDir != "" {
		initial, _ = windows.UTF16PtrFromString(initialDir)
	}
	ofn := openFileNameW{
		hwndOwner:       hostHWND,
		lpstrFilter:     &filter[0],
		nFilterIndex:    1,
		lpstrFile:       &buf[0],
		nMaxFile:        uint32(len(buf)),
		lpstrInitialDir: initial,
		lpstrTitle:      title,
		flags:           ofnFileMustExist | ofnNoChangeDir | ofnPathMustExist | ofnExplorer,
	}
	ofn.lStructSize = uint32(unsafe.Sizeof(ofn))
	r, _, _ := procGetOpenFileNameW.Call(uintptr(unsafe.Pointer(&ofn)))
	runtime.KeepAlive(filter)
	runtime.KeepAlive(buf)
	runtime.KeepAlive(initial)
	if r == 0 {
		return "", false, nil // cancelado (ou erro do dialogo: tratado igual)
	}
	return windows.UTF16ToString(buf), true, nil
}
