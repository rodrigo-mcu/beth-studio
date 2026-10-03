//go:build windows

package main

// serial_helper_windows.go — `bethterm-tool.exe --serial <id>`: roda dentro
// do pane (ConPTY) do host. Abre a porta do perfil, liga teclado <-> porta e
// continua ate' Ctrl+] ou o pane ser fechado. Se a porta some (USB removido)
// ou ainda nao existe, espera ela voltar sem fechar o terminal.

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func serialHelperMain(id string) int {
	con, err := openToolConsole()
	if err != nil {
		return toolFail(nil, "bethterm-tool --serial: "+err.Error())
	}
	defer con.restore()
	if !serialProfileIDRe.MatchString(id) {
		return toolFail(con, "Perfil serial inválido: "+id)
	}
	p, ok, err := serialGetProfile(id)
	if err != nil {
		return toolFail(con, "Não foi possível ler os perfis seriais: "+err.Error())
	}
	if !ok {
		return toolFail(con, "O perfil serial "+id+" não existe mais (foi apagado na interface web).")
	}
	con.setTitle("Serial · " + p.Port)

	var logW io.Writer
	if p.LogFile != "" {
		path := sshExpandHome(p.LogFile)
		_ = os.MkdirAll(filepath.Dir(path), 0o755)
		f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			con.print(fmt.Sprintf("\x1b[33mAviso: não foi possível abrir o log %s: %v\x1b[0m\n", path, err))
		} else {
			defer f.Close()
			fmt.Fprintf(f, "\n--- %s  %s (%s) ---\n", time.Now().Format("2006-01-02 15:04:05"), p.Port, serialDescribe(p))
			logW = f
			con.print("Log: " + path + "\n")
		}
	}
	sess := newSerialSession(p, con, logW)
	con.print(fmt.Sprintf("\x1b[1m%s\x1b[0m  %s\n\x1b[90mCtrl+] encerra.\x1b[0m\n", p.Port, serialDescribe(p)))

	for {
		port, quit := serialWaitOpen(con, p)
		if quit {
			return 0
		}
		con.print("\x1b[32mConectado.\x1b[0m\n")
		end := serialPump(con, sess, port)
		_ = port.Close()
		if end == nil {
			return 0 // Ctrl+]
		}
		con.print(fmt.Sprintf("\n\x1b[33m%s desconectada (%v). Aguardando voltar… (Ctrl+] encerra)\x1b[0m\n", p.Port, end))
	}
}

// serialWaitOpen tenta abrir; porta ausente = espera (1 s) ate' aparecer.
func serialWaitOpen(con *toolConsole, p SerialProfile) (*winSerialPort, bool) {
	warned := ""
	for {
		port, err := serialOpen(p)
		if err == nil {
			return port, false
		}
		if msg := err.Error(); msg != warned {
			con.print("\x1b[33m" + msg + " — tentando de novo a cada segundo (Ctrl+] encerra).\x1b[0m\n")
			warned = msg
		}
		deadline := time.After(time.Second)
	wait:
		for {
			select {
			case b, ok := <-con.keys:
				if !ok || strings.IndexByte(string(b), tcCtrlBracketByte) >= 0 {
					return nil, true
				}
			case <-con.resized:
			case <-deadline:
				break wait
			}
		}
	}
}

// serialPump: nil = o usuario encerrou; erro = a porta caiu.
func serialPump(con *toolConsole, sess *serialSession, port *winSerialPort) error {
	data := make(chan []byte, 16)
	fail := make(chan error, 1)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := port.Read(buf)
			if n > 0 {
				data <- append([]byte(nil), buf[:n]...)
			}
			if err != nil {
				fail <- err
				return
			}
		}
	}()
	for {
		select {
		case b := <-data:
			sess.fromPort(b)
		case err := <-fail:
			for {
				select { // o que ja' chegou antes da queda
				case b := <-data:
					sess.fromPort(b)
					continue
				default:
				}
				break
			}
			if err == nil {
				err = errors.New("fim dos dados")
			}
			return err
		case b, ok := <-con.keys:
			if !ok {
				return nil
			}
			out, quit := sess.fromKeys(b)
			if len(out) > 0 {
				if _, err := port.Write(out); err != nil {
					return err
				}
			}
			if quit {
				return nil
			}
		case <-con.resized:
		}
	}
}
