//go:build windows

package main

import "testing"

func TestZoomScript(t *testing.T) {
	want := "window.__bethstudioZoom&&window.__bethstudioZoom(1.2500)"
	if got := zoomScript(1.25); got != want {
		t.Fatalf("zoomScript = %q, quero %q", got, want)
	}
}

// Sem janela (hostChromium nil) nada acontece nem entra em pânico.
func TestZoomCommandSemJanela(t *testing.T) {
	old := hostChromium
	hostChromium = nil
	defer func() { hostChromium = old }()
	for _, m := range []string{"zoom:get", "zoom:reset"} {
		if !zoomCommand(m) {
			t.Fatalf("%s deveria ser tratado", m)
		}
	}
	if zoomCommand("win:min") {
		t.Fatal("win:min não é do zoom")
	}
	if _, ok := getZoomFactor(); ok {
		t.Fatal("sem janela não há zoom")
	}
}
