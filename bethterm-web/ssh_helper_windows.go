//go:build windows

package main

// ssh_helper_windows.go — `bethterm-tool.exe --ssh <id>`: roda dentro do pane
// (ConPTY) do host. Le o host salvo e a credencial (cofre DPAPI do mesmo
// usuario), conecta, pede um PTY do tamanho do console, repassa
// redimensionamentos e liga teclado <-> sessao remota ate' o outro lado sair.
// Em erro: mensagem clara em pt-BR e espera uma tecla antes de fechar.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

func sshHelperMain(id string) int {
	con, err := openToolConsole()
	if err != nil {
		return toolFail(nil, "bethterm-tool --ssh: "+err.Error())
	}
	defer con.restore()
	if !sshHostIDRe.MatchString(id) {
		return toolFail(con, "Host SSH inválido: "+id)
	}
	secrets.load(dataDir())
	h, ok, err := sshGetHost(id)
	if err != nil {
		return toolFail(con, "Não foi possível ler os hosts SSH: "+err.Error())
	}
	if !ok {
		return toolFail(con, "O host SSH "+id+" não existe mais (foi apagado na interface web).")
	}
	con.setTitle(fmt.Sprintf("%s@%s:%d", h.User, h.Host, h.Port))
	con.print(fmt.Sprintf("\x1b[90mConectando a %s@%s:%d (%s)…\x1b[0m\n", h.User, h.Host, h.Port, h.Name))

	creds := sshCreds{Ask: func(prompt string, echo bool) (string, error) { return con.readLine(prompt, echo) }}
	onUnknown := func(info sshHostKeyInfo) (bool, error) {
		con.print(fmt.Sprintf("\nPrimeira conexão com \x1b[1m%s\x1b[0m.\n"+
			"A identidade do servidor não pode ser confirmada ainda. Chave apresentada:\n"+
			"  %s \x1b[1m%s\x1b[0m\n"+
			"Se você não tem certeza, confira essa impressão digital com quem administra o servidor.\n", info.Addr, info.KeyType, info.Fingerprint))
		return con.askYesNo("Confiar nesta chave e continuar? (s/N) ")
	}
	cl, err := sshDial(h, creds, onUnknown, 20*time.Second)
	if err != nil {
		var ke *sshHostKeyError
		switch {
		case errors.Is(err, errToolAborted):
			return toolFail(con, "Conexão cancelada.")
		case errors.As(err, &ke) && !ke.Info.Mismatch:
			return toolFail(con, "Conexão cancelada: a chave do servidor não foi confirmada.")
		}
		return toolFail(con, "Não foi possível conectar a "+h.Name+":\n"+err.Error())
	}
	defer cl.Close()
	stopKA := make(chan struct{})
	defer close(stopKA)
	go sshKeepAlive(cl, 30*time.Second, stopKA)

	code, err := sshRunShell(con, cl)
	if err != nil {
		return toolFail(con, "A sessão SSH terminou com erro: "+err.Error())
	}
	return code
}

// sshRunShell: PTY + shell; devolve o codigo de saida remoto.
func sshRunShell(con *toolConsole, cl *ssh.Client) (int, error) {
	sess, err := cl.NewSession()
	if err != nil {
		return 1, sshFriendlyErr(err)
	}
	defer sess.Close()
	cols, rows := con.size()
	modes := ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 115200, ssh.TTY_OP_OSPEED: 115200}
	if err := sess.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		return 1, fmt.Errorf("o servidor recusou o terminal (PTY): %v", err)
	}
	stdin, err := sess.StdinPipe()
	if err != nil {
		return 1, err
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		return 1, err
	}
	stderr, err := sess.StderrPipe()
	if err != nil {
		return 1, err
	}
	if err := sess.Shell(); err != nil {
		return 1, fmt.Errorf("o servidor recusou abrir o shell: %v", err)
	}
	fwdCtx, fwdCancel := context.WithCancel(context.Background())
	defer fwdCancel()
	fwd := &sshOutFwd{cl: cl, con: con, ctx: fwdCtx, ports: map[int]bool{}}
	outDone := make(chan struct{})
	go func() { _, _ = io.Copy(io.MultiWriter(con, fwd), stdout); close(outDone) }()
	go func() { _, _ = io.Copy(io.MultiWriter(con, fwd), stderr) }()

	waitErr := make(chan error, 1)
	go func() { waitErr <- sess.Wait() }()

	lastC, lastR := cols, rows
	poll := time.NewTicker(time.Second) // rede de seguranca se um evento de tamanho se perder
	defer poll.Stop()
	resize := func() {
		c, r := con.size()
		if c != lastC || r != lastR {
			lastC, lastR = c, r
			_ = sess.WindowChange(r, c)
		}
	}
	for {
		select {
		case b, ok := <-con.keys:
			if !ok {
				return 0, nil // console fechado: o pane foi encerrado
			}
			if _, err := stdin.Write(b); err != nil {
				// o shell remoto ja' saiu; o Wait diz o codigo
				continue
			}
		case <-con.resized:
			resize()
		case <-poll.C:
			resize()
		case err := <-waitErr:
			select {
			case <-outDone:
			case <-time.After(2 * time.Second):
			}
			if err == nil {
				return 0, nil
			}
			var ee *ssh.ExitError
			if errors.As(err, &ee) {
				return ee.ExitStatus(), nil
			}
			var em *ssh.ExitMissingError
			if errors.As(err, &em) {
				return 0, nil
			}
			if strings.Contains(err.Error(), "EOF") {
				return 1, errors.New("a conexão caiu")
			}
			return 1, err
		}
	}
}
