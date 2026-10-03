package main

// hostctl.go — o que o Studio sabe fazer com o bethterm-host.exe: ver se
// roda, subir, pedir para encerrar. A parte do Windows fica em
// hostctl_windows.go; o resto (log, caminhos, formatos) é testável aqui.

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	hostMutexName     = `Local\BethTermHost`
	hostQuitEventName = `Local\BethTermHostQuit`
	hostExeName       = "bethterm-host.exe"
	guiExeName        = "bethterm-gui.exe"
)

// hostCtl é a fronteira com o sistema: o supervisor só fala com isto.
type hostCtl interface {
	// Running: o mutex do host existe.
	Running() bool
	// Start sobe o host e espera (até 8 s) pelo mutex e por host.sock.
	Start() error
	// RequestQuit pede ao host para sair (fecha todos os terminais). Só
	// depois de o usuário confirmar "Encerrar tudo".
	RequestQuit(requester string) error
	// GUIRunning: a GUI antiga (bethterm-gui.exe) está rodando.
	GUIRunning() bool
}

// lifeLine monta uma linha do host-life.log no mesmo formato do host,
// com a origem "studio".
func lifeLine(t time.Time, pid int, msg string) string {
	return fmt.Sprintf("%s pid=%d studio %s", t.Format("2006-01-02 15:04:05.000"), pid, msg)
}

// lifeLog acrescenta uma linha ao host-life.log (%APPDATA%\bethterm).
func lifeLog(msg string) {
	dir := dataDir()
	if dir == "" {
		return
	}
	_ = os.MkdirAll(dir, 0o755)
	f, err := os.OpenFile(filepath.Join(dir, "host-life.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = fmt.Fprintln(f, lifeLine(time.Now(), os.Getpid(), msg))
}

// hostExeIn: bethterm-host.exe dentro de dir.
func hostExeIn(dir string) (string, error) {
	p := filepath.Join(dir, hostExeName)
	st, err := os.Stat(p)
	if err != nil || st.IsDir() {
		return "", fmt.Errorf("%s não encontrado em %s", hostExeName, dir)
	}
	return p, nil
}

// hostExePath: bethterm-host.exe ao lado do exe do Studio.
func hostExePath() (string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(self); err == nil {
		self = resolved
	}
	return hostExeIn(filepath.Dir(self))
}

// hostID: o id de host de BETHTERM_HOST_ID (o mesmo filtro do host Rust). Vazio
// é o host único de sempre. Os testes usam um id para nunca enxergar o host do usuário:
// com id, o mutex, o evento de saída e os arquivos são outros.
func hostID() string {
	var b strings.Builder
	for _, c := range os.Getenv("BETHTERM_HOST_ID") {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' {
			b.WriteRune(c)
		}
		if b.Len() >= 48 {
			break
		}
	}
	return b.String()
}

func hostMutex() string {
	if id := hostID(); id != "" {
		return hostMutexName + "-" + id
	}
	return hostMutexName
}

func hostQuitEvent() string {
	if id := hostID(); id != "" {
		return hostQuitEventName + "-" + id
	}
	return hostQuitEventName
}

// hostFile: host.<ext> (host único) ou hosts/<id>.<ext>.
func hostFile(ext string) string {
	if id := hostID(); id != "" {
		return filepath.Join(dataDir(), "hosts", id+"."+ext)
	}
	return filepath.Join(dataDir(), "host."+ext)
}

func hostSockPath() string    { return hostFile("sock") }
func hostPidPath() string     { return hostFile("pid") }
func quitRequestPath() string { return hostFile("quit-request") }

// ignoreOldGUI: BETHTERM_IGNORE_GUI=1 faz o Studio ignorar uma GUI antiga (só nos testes).
func ignoreOldGUI() bool { return os.Getenv("BETHTERM_IGNORE_GUI") == "1" }

// quitRequestText: o que o host lê para dizer quem pediu a saída (patch 0168).
func quitRequestText(t time.Time, pid int, exe, reason string) string {
	return fmt.Sprintf("%s pid=%d exe=%s reason=%s", t.Format("2006-01-02 15:04:05.000"), pid, exe, reason)
}

var errHostQuitUnavailable = errors.New("o host não está ouvindo o pedido de saída")
