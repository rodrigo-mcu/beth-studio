//go:build !windows

package main

import "fmt"

func launchTermWindow(s *server, pane int) error {
	_, _ = s, pane
	return fmt.Errorf("a janela de terminal destacada só existe no Windows")
}

func studioScreenToClient(x, y int) (int, int, bool) { return x, y, false }

func runTermMode(pane int, devtools bool, winSize string) {
	_, _, _ = pane, devtools, winSize
	fatal("a janela de terminal destacada só existe no Windows")
}
