// bethstudio-web: Go backend + React UI (WebView2) for the terminals that live
// in the running Beth Studio host.
//
// The Go side spawns ONE `bethstudio.exe cli bridge` child (JSON lines over
// stdin/stdout, see upstream-wezterm/patches/0171-cli-bridge.md), serves the
// embedded React build on 127.0.0.1:<random port>, and relays bridge events to
// every browser connection over a WebSocket. The window is WebView2
// (github.com/jchv/go-webview2, pure Go, no cgo, no WebView2Loader.dll).
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	neturl "net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"time"
)

func main() {
	// Terminais de ferramenta (bethstudio-tool.exe --ssh|--serial <id>) rodando
	// no pane do host. Antes de tudo: sem log, sem porta, sem janela.
	if code, ok := toolHelperMain(os.Args[1:]); ok {
		os.Exit(code)
	}
	// Processo auxiliar do Gerenciador de tarefas (sysmon): le titulos de
	// console e sai. Antes de tudo (sem log, sem porta, sem janela).
	if len(os.Args) == 3 && os.Args[1] == consoleTitlesFlag {
		os.Exit(consoleTitlesHelperMain(os.Args[2]))
	}
	// Antes do bridge: os terminais que ele cria herdam este ambiente (agentenv.go).
	droppedEnv := dropAgentEnv()
	var (
		exeFlag   = flag.String("bethstudio", "", "caminho do bethstudio.exe (padrao: env BETHSTUDIO_EXE, ao lado deste exe ou o build do repo)")
		noWindow  = flag.Bool("no-window", false, "nao abre a janela WebView2; so imprime a URL")
		readOnly  = flag.Bool("read-only", false, "recusa send/paste (so list/watch) — para testes")
		port      = flag.Int("port", 0, "porta fixa em 127.0.0.1 (0 = aleatoria)")
		devtools  = flag.Bool("devtools", false, "habilita DevTools no WebView2")
		devOrig   = flag.String("dev-origin", "", "origem extra aceita (ex. http://127.0.0.1:5181 do vite dev)")
		openIDs   = flag.String("open", "", "panes para abrir na UI, ex. 9 ou 9,10")
		winSize   = flag.String("window-size", "1440x900", "tamanho inicial da janela, LxA")
		diag      = flag.Bool("diag", false, "a UI manda diagnosticos (fonte efetiva etc.) para o log")
		sftpHost  = flag.String("sftp", "", "abre so' a janela SFTP do host salvo (id hex de 16 digitos)")
		dbWindow  = flag.Bool("db", false, "abre só a janela Banco de dados (barra de tarefas própria)")
		supervise = flag.Bool("supervise", false, "liga a supervisão do host mesmo com --no-window (testes)")
		termPane  = flag.Int("term", -1, "abre só a janela destacada do terminal <pane> (aberta pelo Studio)")
	)
	flag.Parse()

	if id := strings.TrimSpace(*sftpHost); id != "" {
		runSFTPMode(id, *noWindow, *devtools, *port, *winSize, *devOrig)
		return
	}
	if *termPane >= 0 {
		runTermMode(*termPane, *devtools, *winSize)
		return
	}
	if *dbWindow {
		runDBMode(*noWindow, *devtools, *port, *winSize, *devOrig)
		return
	}

	attachParentConsole()
	logClose := setupLog()
	defer logClose()

	// Um Studio só (startup_windows.go): o segundo clique traz a janela aberta.
	if !*noWindow && !claimSingleStudio() {
		return
	}

	exe := resolveExe(*exeFlag)
	token := randomToken()

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		fatal("não foi possível abrir a porta local: %v", err)
	}
	addr := ln.Addr().(*net.TCPAddr)
	base := fmt.Sprintf("http://127.0.0.1:%d", addr.Port)
	url := fmt.Sprintf("%s/?t=%s", base, token)
	if v := strings.TrimSpace(*openIDs); v != "" {
		url += "&open=" + neturl.QueryEscape(v)
	}
	if *diag {
		url += "&diag=1"
	}

	settings.load(dataDir())
	importWSLDistrosFile(dataDir(), settings) // migra o wsl-distros.json antigo para a tela de Configurações
	secrets.load(dataDir())
	// Scan themes and fonts in the background so the first menu opens fast.
	go func() {
		themes.get(false)
		fonts.get(false)
	}()

	hub := newHub(*readOnly)
	settings.onChg = func(s SettingsSnapshot) { hub.broadcast(s) }
	// Studio remoto (remote_auth.go): sessões, registro de acessos.
	remoteLogDir = appDataDir()
	remote.load()
	remote.onDrop = hub.dropRemote
	phone.onDrop = hub.dropPhone
	br := newBridge(exe, hub)
	hub.bridge = br

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// O Studio sobe e vigia o host (supervisor.go). Nos testes com
	// --no-window só com --supervise, para nao mexer no host de ninguem.
	if !*noWindow || *supervise {
		ctl := newHostCtl()
		hub.sup = newSupervisor(ctl, newRestartLimiter(3, 10*time.Minute), time.Now, hub.setHost)
		go hub.sup.Run(ctx)
		// Restauracao dos terminais depois de uma queda (restore*.go) e gate do WSL.
		hub.wslGate = newWSLGate(execRunner)
		hub.restore = newHubRestore(hub)
		// Bandeja do Studio (tray_windows.go): só sobe se a GUI antiga não estiver cuidando dela.
		go runTrayWhenFree(ctx, hub, hub.sup, ctl)
	}
	go br.run(ctx)
	// Tipos dos terminais: pane-commands.json da GUI pode mudar sem a lista
	// mudar (a GUI grava o comando logo depois de criar o pane).
	go func() {
		t := time.NewTicker(3 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				hub.refreshKinds(false)
			}
		}
	}()

	web := newServer(token, addr.Port, *devOrig, hub)
	srv := &http.Server{
		Handler:           web,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go web.(*server).runPhoneLink(ctx)
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("http: %v", err)
		}
	}()

	log.Printf("bethstudio-web: bridge exe=%s read_only=%v", exe, *readOnly)
	if len(droppedEnv) > 0 {
		log.Printf("bethstudio-web: variáveis de sessão de agente fora dos terminais: %s", strings.Join(droppedEnv, ", "))
	}
	log.Printf("bethstudio-web: servindo em %s", base)
	// Ponte de agentes (ponte.go): publica <dados>\ponte.json se estiver ligada.
	ponteSetAddr(dataDir(), base, token)
	defer ponteUnpublish()
	fmt.Fprintln(os.Stdout, url)

	if *noWindow {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt)
		<-sig
	} else {
		w, h := 1440, 900
		if _, err := fmt.Sscanf(*winSize, "%dx%d", &w, &h); err != nil || w < 400 || h < 300 {
			w, h = 1440, 900
		}
		if err := openWindow(url, *devtools, w, h); err != nil {
			messageBox(appTitle, "Não foi possível abrir a janela (WebView2):\n\n"+err.Error()+
				"\n\nInstale o Microsoft Edge WebView2 Runtime ou rode com --no-window e abra a URL no navegador.")
		}
	}

	log.Printf("bethstudio-web: encerrando")
	stopTray()
	hub.term.CloseAll() // só as janelas destacadas; os terminais seguem no host
	cancel()
	br.stop()
	settings.flush()
	shutCtx, c2 := context.WithTimeout(context.Background(), 2*time.Second)
	defer c2()
	_ = srv.Shutdown(shutCtx)
}

func resolveExe(flagVal string) string {
	if v := strings.TrimSpace(flagVal); v != "" {
		return v
	}
	if v := strings.TrimSpace(os.Getenv("BETHSTUDIO_EXE")); v != "" {
		return v
	}
	// ao lado deste exe (instalacao) ou no build de desenvolvimento do repo
	if self, err := os.Executable(); err == nil {
		dir := filepath.Dir(self)
		for _, c := range []string{
			filepath.Join(dir, "bethstudio.exe"),
			filepath.Join(dir, "..", "upstream-wezterm", "target", "release", "bethstudio.exe"),
		} {
			if st, err := os.Stat(c); err == nil && !st.IsDir() {
				return c
			}
		}
	}
	return "bethstudio.exe" // no PATH
}

func randomToken() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// setupLog writes to %LOCALAPPDATA%\bethstudio-web\bethstudio-web.log and to
// stderr (when there is one: windowsgui builds have none unless launched from
// a shell that redirects it, or the parent console was attached).
func setupLog() func() {
	dir := appDataDir()
	var writers []io.Writer
	var f *os.File
	if dir != "" {
		if err := os.MkdirAll(dir, 0o755); err == nil {
			p := filepath.Join(dir, "bethstudio-web.log")
			if st, err := os.Stat(p); err == nil && st.Size() > 4<<20 {
				_ = os.Rename(p, p+".old")
			}
			f, _ = os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
			if f != nil {
				writers = append(writers, f)
			}
		}
	}
	// stderr last: io.MultiWriter stops at the first failing writer.
	if stdioOK {
		writers = append(writers, os.Stderr)
	}
	if len(writers) == 0 {
		writers = append(writers, io.Discard)
	}
	log.SetOutput(io.MultiWriter(writers...))
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	// Several instances may share this log (installed copy + tests).
	log.SetPrefix(fmt.Sprintf("[%d] ", os.Getpid()))
	return func() {
		if f != nil {
			_ = f.Close()
		}
	}
}

func appDataDir() string {
	la := os.Getenv("LOCALAPPDATA")
	if la == "" {
		return ""
	}
	return filepath.Join(la, "bethstudio-web")
}

func fatal(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	log.Print(msg)
	messageBox(appTitle, msg)
	os.Exit(1)
}
