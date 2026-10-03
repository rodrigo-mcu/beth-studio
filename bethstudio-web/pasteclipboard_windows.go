package main

import (
	"errors"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const cfHdrop = 15

var (
	procOpenClipboard    = windows.NewLazySystemDLL("user32.dll").NewProc("OpenClipboard")
	procCloseClipboard   = windows.NewLazySystemDLL("user32.dll").NewProc("CloseClipboard")
	procGetClipboardData = windows.NewLazySystemDLL("user32.dll").NewProc("GetClipboardData")
	procDragQueryFile    = windows.NewLazySystemDLL("shell32.dll").NewProc("DragQueryFileW")
)

// readOSClipboardFiles returns paths copied in Explorer (CF_HDROP).
// An empty slice means the clipboard has no file list.
func readOSClipboardFiles() ([]string, error) {
	var last error
	opened := false
	for i := 0; i < 10; i++ {
		r, _, e := procOpenClipboard.Call(0)
		if r != 0 {
			opened = true
			break
		}
		last = e
		time.Sleep(20 * time.Millisecond)
	}
	if !opened {
		if last == nil {
			last = errors.New("não foi possível abrir a área de transferência")
		}
		return nil, last
	}
	defer procCloseClipboard.Call()

	h, _, _ := procGetClipboardData.Call(cfHdrop)
	if h == 0 {
		return nil, nil
	}
	count, _, _ := procDragQueryFile.Call(h, 0xFFFFFFFF, 0, 0)
	if count == 0 {
		return nil, nil
	}
	buf := make([]uint16, 32768)
	out := make([]string, 0, count)
	for i := uintptr(0); i < count; i++ {
		n, _, _ := procDragQueryFile.Call(h, i, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
		if n == 0 {
			continue
		}
		out = append(out, windows.UTF16ToString(buf))
	}
	return out, nil
}
