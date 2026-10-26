//go:build windows

package main

import "testing"

func TestWebviewVisibilityFor(t *testing.T) {
	cases := []struct {
		name       string
		msg        uint32
		wp         uintptr
		bg, handle bool
	}{
		{"esconder (bandeja)", wmShowWindow, 0, true, true},
		{"mostrar", wmShowWindow, 1, false, true},
		{"minimizar", wmSize, sizeMinimized, true, true},
		{"restaurar", wmSize, 0, false, true}, // SIZE_RESTORED
		{"maximizar", wmSize, 2, false, true}, // SIZE_MAXIMIZED
		{"outra mensagem", wmMove, 0, false, false},
	}
	for _, c := range cases {
		bg, ok := webviewVisibilityFor(c.msg, c.wp)
		if bg != c.bg || ok != c.handle {
			t.Errorf("%s: got (%v,%v), want (%v,%v)", c.name, bg, ok, c.bg, c.handle)
		}
	}
}

// Sem janela (hostChromium nil) nada acontece nem entra em panico.
func TestSetWebviewBackgroundWithoutWindow(t *testing.T) {
	old := hostChromium
	hostChromium = nil
	defer func() { hostChromium = old }()
	setWebviewBackground(true)
	setWebviewBackground(false)
}
