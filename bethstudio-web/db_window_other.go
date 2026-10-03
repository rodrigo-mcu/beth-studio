//go:build !windows

package main

import "fmt"

var dbStandalone bool

func openDBWindow() error {
	return fmt.Errorf("a janela do banco só existe no Windows")
}

func runDBMode(noWindow, devtools bool, port int, winSize, devOrig string) {
	_, _, _, _, _ = noWindow, devtools, port, winSize, devOrig
	fatal("a janela do banco só existe no Windows")
}
