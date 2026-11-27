//go:build !windows

package main

import "fmt"

func openEditorWindow(path string, edit bool) error {
	_, _ = path, edit
	return fmt.Errorf("a janela separada do editor só existe no Windows")
}

func runEditorMode(path string, edit, devtools bool, port int, winSize, devOrig string) {
	_, _, _, _, _, _ = path, edit, devtools, port, winSize, devOrig
	fatal("a janela separada do editor só existe no Windows")
}
