//go:build windows

package main

// tool_console_windows.go — o console do pane (ConPTY do host) para os
// auxiliares --ssh / --serial: modo cru, UTF-8, teclas como bytes VT,
// eventos de redimensionamento e perguntas simples (s/N, senha sem eco).
//
// Um unico leitor (ReadConsoleInputW) alimenta um canal de bytes e um canal
// de "mudou o tamanho"; as perguntas e a sessao consomem desses canais, entao
// nunca ha dois leitores disputando o console.

import (
	"errors"
	"os"
	"strings"
	"sync"
	"unicode/utf16"
	"unicode/utf8"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	tcKernel32           = windows.NewLazySystemDLL("kernel32.dll")
	tcReadConsoleInputW  = tcKernel32.NewProc("ReadConsoleInputW")
	tcSetConsoleTitleW   = tcKernel32.NewProc("SetConsoleTitleW")
	tcGetConsoleCP       = tcKernel32.NewProc("GetConsoleCP")
	tcGetConsoleOutputCP = tcKernel32.NewProc("GetConsoleOutputCP")
	tcSetConsoleCP       = tcKernel32.NewProc("SetConsoleCP")
	tcSetConsoleOutputCP = tcKernel32.NewProc("SetConsoleOutputCP")
)

const (
	tcKeyEvent        = 0x0001
	tcWindowSizeEvent = 0x0004
	tcVKMenu          = 0x12
	tcCtrlC           = 0x03
	tcCtrlBracket     = 0x1d // Ctrl+] : encerra a sessao (como no telnet)
)

// errToolAborted: o usuario apertou Ctrl+C numa pergunta.
var errToolAborted = errors.New("cancelado pelo usuário")

type tcInputRecord struct {
	EventType uint16
	_         uint16
	Event     [16]byte
}

type toolConsole struct {
	in, out           windows.Handle
	oldIn, oldOut     uint32
	oldInCP, oldOutCP uintptr

	keys    chan []byte
	resized chan struct{}

	wmu     sync.Mutex
	pending []byte // bytes UTF-8 incompletos do ultimo Write
}

// openToolConsole: exige um console de verdade (o pane do host).
func openToolConsole() (*toolConsole, error) {
	in, err := windows.GetStdHandle(windows.STD_INPUT_HANDLE)
	if err != nil {
		return nil, err
	}
	out, err := windows.GetStdHandle(windows.STD_OUTPUT_HANDLE)
	if err != nil {
		return nil, err
	}
	c := &toolConsole{in: in, out: out, keys: make(chan []byte, 64), resized: make(chan struct{}, 1)}
	if err := windows.GetConsoleMode(in, &c.oldIn); err != nil {
		return nil, errors.New("sem console (este modo precisa rodar dentro de um terminal)")
	}
	if err := windows.GetConsoleMode(out, &c.oldOut); err != nil {
		return nil, errors.New("sem console de saída")
	}
	c.oldInCP, _, _ = tcGetConsoleCP.Call()
	c.oldOutCP, _, _ = tcGetConsoleOutputCP.Call()
	tcSetConsoleCP.Call(65001)
	tcSetConsoleOutputCP.Call(65001)
	_ = windows.SetConsoleMode(out, windows.ENABLE_PROCESSED_OUTPUT|windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING|windows.DISABLE_NEWLINE_AUTO_RETURN)
	// Cru desde o inicio: as perguntas fazem o proprio eco.
	if err := windows.SetConsoleMode(in, windows.ENABLE_VIRTUAL_TERMINAL_INPUT|windows.ENABLE_WINDOW_INPUT); err != nil {
		return nil, err
	}
	go c.readLoop()
	return c, nil
}

func (c *toolConsole) restore() {
	_ = windows.SetConsoleMode(c.in, c.oldIn)
	_ = windows.SetConsoleMode(c.out, c.oldOut)
	if c.oldInCP != 0 {
		tcSetConsoleCP.Call(c.oldInCP)
	}
	if c.oldOutCP != 0 {
		tcSetConsoleOutputCP.Call(c.oldOutCP)
	}
}

func (c *toolConsole) setTitle(t string) {
	p, err := windows.UTF16PtrFromString(t)
	if err == nil {
		tcSetConsoleTitleW.Call(uintptr(unsafe.Pointer(p)))
	}
	// OSC 0/2: o host (ConPTY) muitas vezes fica com o nome do exe até
	// receber o título pela saída do terminal.
	esc := strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, t)
	if esc != "" {
		c.print("\x1b]0;" + esc + "\x07\x1b]2;" + esc + "\x07")
	}
}

// size: colunas x linhas visiveis.
func (c *toolConsole) size() (cols, rows int) {
	var info windows.ConsoleScreenBufferInfo
	if err := windows.GetConsoleScreenBufferInfo(c.out, &info); err != nil {
		return 80, 24
	}
	cols = int(info.Window.Right-info.Window.Left) + 1
	rows = int(info.Window.Bottom-info.Window.Top) + 1
	if cols < 2 || rows < 1 {
		return 80, 24
	}
	return cols, rows
}

// readLoop: teclas (ja' traduzidas em VT pelo console) -> UTF-8.
func (c *toolConsole) readLoop() {
	recs := make([]tcInputRecord, 128)
	var hi uint16 // surrogate alto pendente
	for {
		var n uint32
		r, _, _ := tcReadConsoleInputW.Call(uintptr(c.in), uintptr(unsafe.Pointer(&recs[0])), uintptr(len(recs)), uintptr(unsafe.Pointer(&n)))
		if r == 0 {
			close(c.keys)
			return
		}
		var buf []byte
		for _, rec := range recs[:n] {
			switch rec.EventType {
			case tcWindowSizeEvent:
				select {
				case c.resized <- struct{}{}:
				default:
				}
			case tcKeyEvent:
				down := *(*int32)(unsafe.Pointer(&rec.Event[0])) != 0
				repeat := *(*uint16)(unsafe.Pointer(&rec.Event[4]))
				vk := *(*uint16)(unsafe.Pointer(&rec.Event[6]))
				ch := *(*uint16)(unsafe.Pointer(&rec.Event[10]))
				if ch == 0 || (!down && vk != tcVKMenu) { // Alt+codigo chega no key-up do Alt
					continue
				}
				if repeat == 0 {
					repeat = 1
				}
				for i := uint16(0); i < repeat; i++ {
					switch {
					case utf16.IsSurrogate(rune(ch)) && ch < 0xdc00:
						hi = ch
					case utf16.IsSurrogate(rune(ch)):
						if hi != 0 {
							buf = utf8.AppendRune(buf, utf16.DecodeRune(rune(hi), rune(ch)))
						}
						hi = 0
					default:
						hi = 0
						buf = utf8.AppendRune(buf, rune(ch))
					}
				}
			}
		}
		if len(buf) > 0 {
			c.keys <- buf
		}
	}
}

// Write: bytes UTF-8 para a tela; guarda um caractere cortado no fim para o
// proximo Write (a rede entrega pedacos arbitrarios).
func (c *toolConsole) Write(p []byte) (int, error) {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	data := p
	if len(c.pending) > 0 {
		data = append(append([]byte(nil), c.pending...), p...)
		c.pending = c.pending[:0]
	}
	cut := len(data)
	for i := len(data) - 1; i >= 0 && i >= len(data)-utf8.UTFMax; i-- {
		if utf8.RuneStart(data[i]) {
			if !utf8.FullRune(data[i:]) {
				cut = i
			}
			break
		}
	}
	c.pending = append(c.pending, data[cut:]...)
	data = data[:cut]
	for len(data) > 0 {
		var n uint32
		if err := windows.WriteFile(c.out, data, &n, nil); err != nil {
			return len(p), err
		}
		data = data[n:]
	}
	return len(p), nil
}

func (c *toolConsole) print(s string) { _, _ = c.Write([]byte(strings.ReplaceAll(s, "\n", "\r\n"))) }

// readLine: pergunta simples. echo=false para senhas (mostra nada).
func (c *toolConsole) readLine(prompt string, echo bool) (string, error) {
	c.print(prompt)
	var line []rune
	for {
		b, ok := <-c.keys
		if !ok {
			return "", errors.New("console fechado")
		}
		// sequencias VT (setas etc.) sao ignoradas nas perguntas
		s := string(b)
		for len(s) > 0 {
			if s[0] == 0x1b {
				s = tcSkipEscape(s)
				continue
			}
			r, sz := utf8.DecodeRuneInString(s)
			s = s[sz:]
			switch r {
			case '\r', '\n':
				c.print("\r\n")
				return string(line), nil
			case tcCtrlC, tcCtrlBracket:
				c.print("^C\r\n")
				return "", errToolAborted
			case 0x08, 0x7f:
				if len(line) > 0 {
					line = line[:len(line)-1]
					if echo {
						c.print("\b \b")
					}
				}
			case 0x15: // Ctrl+U: apaga a linha
				if echo {
					c.print(strings.Repeat("\b \b", len(line)))
				}
				line = line[:0]
			default:
				if r >= 0x20 && len(line) < 4096 {
					line = append(line, r)
					if echo {
						c.print(string(r))
					}
				}
			}
		}
	}
}

// tcSkipEscape pula uma sequencia ESC [ ... final / ESC O x / ESC x.
func tcSkipEscape(s string) string {
	if len(s) < 2 {
		return ""
	}
	switch s[1] {
	case '[':
		for i := 2; i < len(s); i++ {
			if s[i] >= 0x40 && s[i] <= 0x7e {
				return s[i+1:]
			}
		}
		return ""
	case 'O':
		if len(s) >= 3 {
			return s[3:]
		}
		return ""
	}
	return s[2:]
}

// askYesNo: "s"/"sim" = true; qualquer outra coisa = false.
func (c *toolConsole) askYesNo(prompt string) (bool, error) {
	ans, err := c.readLine(prompt, true)
	if err != nil {
		return false, err
	}
	switch strings.ToLower(strings.TrimSpace(ans)) {
	case "s", "sim", "y", "yes":
		return true, nil
	}
	return false, nil
}

// waitKey: mostra msg e espera qualquer tecla (erros: o pane nao some antes
// de o usuario ler).
func (c *toolConsole) waitKey(msg string) {
	c.print(msg)
	for {
		select {
		case _, ok := <-c.keys:
			if !ok {
				return
			}
			c.print("\r\n")
			return
		case <-c.resized:
		}
	}
}

// toolConsoleExitCode: codigo de saida padrao dos auxiliares.
func toolFail(c *toolConsole, format string) int {
	if c == nil {
		os.Stderr.WriteString(format + "\n")
		return 1
	}
	c.print("\r\n\x1b[31m" + format + "\x1b[0m\r\n")
	c.waitKey("\r\nPressione qualquer tecla para fechar este terminal.")
	return 1
}
