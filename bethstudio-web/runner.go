package main

import (
	"context"
	"os/exec"
	"time"
)

// execRunner executa um programa sem janela, com limite de tempo (gate do WSL).
func execRunner(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	hideChildWindow(&cmd.SysProcAttr)
	return cmd.Output()
}
