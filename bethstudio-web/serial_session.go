package main

// serial_session.go — a parte da sessao serial que nao depende do Windows:
// o que vai da porta para a tela/log (carimbo de hora opcional) e o que vai
// do teclado para a porta (fim de linha do Enter, eco local). Testada com
// uma porta falsa (serial_session_test.go).

import (
	"fmt"
	"io"
	"strings"
	"time"
)

type serialSession struct {
	p   SerialProfile
	out io.Writer // tela do pane
	log io.Writer // nil = sem log
	now func() time.Time

	screenBOL bool // inicio de linha na tela (para o carimbo)
	logBOL    bool
}

func newSerialSession(p SerialProfile, out, log io.Writer) *serialSession {
	return &serialSession{p: p, out: out, log: log, now: time.Now, screenBOL: true, logBOL: true}
}

func (s *serialSession) stamp() string { return s.now().Format("15:04:05.000") }

// fromPort: bytes recebidos -> tela (e log).
func (s *serialSession) fromPort(b []byte) {
	if len(b) == 0 {
		return
	}
	if !s.p.Timestamps {
		_, _ = s.out.Write(b)
		if s.log != nil {
			_, _ = s.log.Write(b)
		}
		return
	}
	var scr, lg strings.Builder
	ts := s.stamp()
	for _, c := range b {
		if s.screenBOL && c != '\r' && c != '\n' {
			scr.WriteString("\x1b[90m[" + ts + "]\x1b[0m ")
			s.screenBOL = false
		}
		if s.logBOL && c != '\r' && c != '\n' {
			lg.WriteString("[" + ts + "] ")
			s.logBOL = false
		}
		scr.WriteByte(c)
		lg.WriteByte(c)
		if c == '\n' {
			s.screenBOL, s.logBOL = true, true
		}
	}
	_, _ = io.WriteString(s.out, scr.String())
	if s.log != nil {
		_, _ = io.WriteString(s.log, lg.String())
	}
}

// fromKeys: teclas -> bytes para a porta. quit=true com Ctrl+] (o resto do
// pedaco e' descartado).
func (s *serialSession) fromKeys(b []byte) (toPort []byte, quit bool) {
	var echo []byte
	for _, c := range b {
		if c == tcCtrlBracketByte {
			quit = true
			break
		}
		if c == '\r' {
			switch s.p.LineEnding {
			case "lf":
				toPort = append(toPort, '\n')
			case "crlf":
				toPort = append(toPort, '\r', '\n')
			default:
				toPort = append(toPort, '\r')
			}
			echo = append(echo, '\r', '\n')
			continue
		}
		toPort = append(toPort, c)
		if c == 0x7f || c == 0x08 {
			echo = append(echo, '\b', ' ', '\b')
		} else {
			echo = append(echo, c)
		}
	}
	if s.p.LocalEcho && len(echo) > 0 {
		_, _ = s.out.Write(echo)
	}
	return toPort, quit
}

// tcCtrlBracketByte: Ctrl+] encerra (igual ao telnet).
const tcCtrlBracketByte = 0x1d

// serialDescribe: "115200 8N1, fluxo RTS/CTS, Enter = CR".
func serialDescribe(p SerialProfile) string {
	par := map[string]string{"none": "N", "odd": "O", "even": "E", "mark": "M", "space": "S"}[p.Parity]
	flow := map[string]string{"none": "sem controle de fluxo", "rtscts": "fluxo RTS/CTS", "xonxoff": "fluxo XON/XOFF"}[p.Flow]
	return fmt.Sprintf("%d %d%s%s, %s, Enter = %s", p.Baud, p.DataBits, par, p.StopBits, flow, strings.ToUpper(p.LineEnding))
}
