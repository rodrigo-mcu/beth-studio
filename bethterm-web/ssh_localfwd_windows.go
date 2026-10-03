//go:build windows

package main

// Liga a saída do SSH ao encaminhador: URL localhost (ou redirect_uri para
// localhost) vira escuta local + abre o navegador deste PC.

import (
	"context"
	"fmt"
	"os/exec"
	"sync"

	"golang.org/x/crypto/ssh"
)

type sshOutFwd struct {
	cl    *ssh.Client
	con   *toolConsole
	ctx   context.Context
	mu    sync.Mutex
	watch localFwdWatch
	ports map[int]bool
}

func (h *sshOutFwd) Write(p []byte) (int, error) {
	h.mu.Lock()
	hits := h.watch.feed(string(p))
	h.mu.Unlock()
	for _, hit := range hits {
		h.start(hit)
	}
	return len(p), nil
}

func (h *sshOutFwd) start(hit localFwdHit) {
	h.mu.Lock()
	already := h.ports[hit.Port]
	if !already {
		if err := sshLocalForward(h.ctx, h.cl, hit.Port); err != nil {
			h.mu.Unlock()
			h.con.print(fmt.Sprintf("\r\n\x1b[33mBethTerm: a porta %d deste PC já está em uso (%v). Não deu para encaminhar o login. No agente, use o código do dispositivo (device code).\x1b[0m\r\n", hit.Port, err))
			return
		}
		h.ports[hit.Port] = true
	}
	h.mu.Unlock()
	if !already {
		h.con.print(fmt.Sprintf("\r\n\x1b[90mBethTerm: porta %d do servidor encaminhada para este PC (login do agente). Abrindo o navegador…\x1b[0m\r\n", hit.Port))
	}
	openSystemBrowser(hit.URL)
}

func openSystemBrowser(raw string) {
	u, err := validateExternalURL(raw)
	if err != nil {
		return
	}
	cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", u)
	hideChildWindow(&cmd.SysProcAttr)
	_ = cmd.Start()
}
