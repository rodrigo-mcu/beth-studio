//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
)

// revealInExplorer abre a pasta (selecionando o arquivo, se existir).
// So' caminhos da lista fixa de aboutFiles chegam aqui.
func revealInExplorer(path string, exists bool) error {
	var cmd *exec.Cmd
	if exists {
		cmd = exec.Command("explorer.exe", "/select,"+path)
	} else {
		dir := filepath.Dir(path)
		if _, err := os.Stat(dir); err != nil {
			return errors.New("a pasta ainda não existe")
		}
		cmd = exec.Command("explorer.exe", dir)
	}
	// Sem hideChildWindow: explorer.exe nao e' exe de console. Com
	// CREATE_NO_WINDOW / HideWindow a janela de pasta nasce com SW_HIDE e o
	// processo explorer.exe fica vivo, invisivel, para sempre.
	return cmd.Start()
}
