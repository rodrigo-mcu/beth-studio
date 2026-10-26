//go:build windows

package main

import (
	"context"
	"encoding/base64"
	"errors"
	"os/exec"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
)

const createNoWindow = 0x08000000

func psCommand(ctx context.Context, script string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	return cmd
}

// detectAntivirus: nomes registrados na Central de Seguranca (sem administrador).
func detectAntivirus() ([]string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	out, err := psCommand(ctx, "Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntivirusProduct -ErrorAction SilentlyContinue | ForEach-Object { $_.displayName }").Output()
	if err != nil {
		return nil, true
	}
	var names []string
	seen := map[string]bool{}
	for _, l := range strings.Split(strings.ReplaceAll(string(out), "\r", ""), "\n") {
		l = strings.TrimSpace(l)
		if l != "" && !seen[l] {
			seen[l] = true
			names = append(names, l)
		}
	}
	return names, true
}

// runDefenderElevated executa `inner` num PowerShell elevado (aparece o UAC) e devolve o codigo de saida dele.
func runDefenderElevated(ctx context.Context, inner string) (int, error) {
	u := utf16.Encode([]rune(inner))
	raw := make([]byte, 0, len(u)*2)
	for _, c := range u {
		raw = append(raw, byte(c), byte(c>>8))
	}
	enc := base64.StdEncoding.EncodeToString(raw)
	// Recusar o UAC faz o Start-Process lancar excecao: vira 1223.
	outer := "try { $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden " +
		"-ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','" + enc + "'); exit $p.ExitCode } catch { exit 1223 }"
	err := psCommand(ctx, outer).Run()
	if err == nil {
		return 0, nil
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), nil
	}
	return 0, err
}

// openWindowsSecurity abre "Protecao contra virus e ameacas" (de la' o usuario chega em Exclusoes).
func openWindowsSecurity() error {
	return exec.Command("cmd", "/c", "start", "", "windowsdefender://threatsettings").Start()
}
