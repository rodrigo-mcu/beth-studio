package main

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	tokenHeader  = "X-BethStudio-Token"
	maxDataBytes = 4 << 20 // send/paste payload limit
)

type server struct {
	token      string
	port       int
	origin     string // http://127.0.0.1:<port>
	devOrigin  string
	cookieName string
	hub        *hub
	static     http.Handler
}

func newServer(token string, port int, devOrigin string, h *hub) http.Handler {
	s := &server{
		token:      token,
		port:       port,
		origin:     fmt.Sprintf("http://127.0.0.1:%d", port),
		devOrigin:  strings.TrimRight(strings.TrimSpace(devOrigin), "/"),
		cookieName: fmt.Sprintf("bethstudio_web_%d", port),
		hub:        h,
		static: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.FileServer(http.FS(currentUI().FS)).ServeHTTP(w, r)
		}),
	}
	return s
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// DNS-rebinding guard: only our own loopback host names.
	host := r.Host
	if host != fmt.Sprintf("127.0.0.1:%d", s.port) && host != fmt.Sprintf("localhost:%d", s.port) {
		http.Error(w, "host inválido", http.StatusForbidden)
		return
	}
	if o := r.Header.Get("Origin"); o != "" && !s.originOK(o) {
		http.Error(w, "origem inválida", http.StatusForbidden)
		return
	}
	fromQuery, ok := s.tokenOK(r)
	if !ok {
		http.Error(w, "token ausente ou inválido", http.StatusUnauthorized)
		return
	}

	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("Referrer-Policy", "no-referrer") // the token travels in the first URL
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Content-Security-Policy", fmt.Sprintf(
		"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "+
			"font-src 'self' data:; connect-src 'self' ws://127.0.0.1:%d ws://localhost:%d; frame-ancestors 'none'",
		s.port, s.port))

	if fromQuery {
		// Module scripts and CSS loaded by index.html carry no token; a
		// strict, HttpOnly, per-port cookie covers them.
		http.SetCookie(w, &http.Cookie{
			Name: s.cookieName, Value: s.token, Path: "/",
			HttpOnly: true, SameSite: http.SameSiteStrictMode,
		})
	}

	s.route(w, r, "")
}

// route: as rotas do Studio. remoteKey != "" quando o pedido veio do Studio
// remoto (remote_gate.go), que já conferiu login, origem e o que só existe no PC.
func (s *server) route(w http.ResponseWriter, r *http.Request, remoteKey string) {
	// SSH salvo / porta serial (docs/INTEGRATION-ssh.md)
	if strings.HasPrefix(r.URL.Path, "/api/ssh/") {
		s.serveSSH(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/serial/") {
		s.serveSerial(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/term/") {
		s.serveTerm(w, r, remoteKey)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/host/") {
		s.serveHost(w, r, remoteKey)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/db/") {
		s.serveDB(w, r)
		return
	}
	switch r.URL.Path {
	case "/ws":
		if remoteKey != "" {
			s.serveWSWith(w, r, func(c *client) { c.remote = remoteKey })
		} else {
			s.serveWS(w, r, false)
		}
	case "/api/phone/setup":
		s.servePhoneSetup(w, r)
	case "/api/remote", "/api/remote/totp", "/api/remote/revoke":
		s.serveRemoteAdmin(w, r)
	case "/healthz":
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok\n"))
	case "/api/paste-image", "/api/paste-file":
		s.servePaste(w, r)
	case "/api/paste-clipboard":
		if remoteKey != "" {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "colar arquivo do Explorer só no computador"})
			return
		}
		s.servePasteClipboard(w, r)
	case "/api/settings/ui-css":
		s.serveUICSS(w, r)
	case "/api/voice", "/api/voice/settings", "/api/voice/key", "/api/voice/test", "/api/voice/models",
		"/api/voice/account/start", "/api/voice/account/poll", "/api/voice/account/logout",
		"/api/voice/open-keys", "/api/voice/correct", "/api/voice/transcribe",
		"/api/voice/open-pricing", "/api/voice/catalog", "/api/voice/sample", "/api/voice/tech-vocab":
		s.serveVoice(w, r)
	case "/api/ai-usage", "/api/ai-usage/export", "/api/ai-usage/open":
		serveAIUsage(w, r)
	case "/api/log":
		serveUILog(w, r)
	case "/api/open-link":
		serveOpenLink(w, r)
	case "/api/local-file":
		serveLocalFile(w, r)
	case "/api/local-file/open-default":
		serveOpenLocalFileDefault(w, r)
	case "/api/local-file/save-as":
		serveLocalFileSaveAs(w, r)
	case "/api/local-file/reveal":
		serveLocalFileReveal(w, r)
	case "/api/local-file/write":
		serveLocalFileWrite(w, r)
	case "/api/local-file/create":
		serveLocalFileCreate(w, r)
	case "/api/local-file/open-dialog":
		serveLocalFileOpenDialog(w, r)
	case "/api/notes", "/api/notes/read", "/api/notes/save", "/api/notes/delete":
		serveNotes(w, r)
	case "/api/pick-folder":
		servePickFolder(w, r)
	case "/api/local-fs/list", "/api/local-fs/mkdir", "/api/local-fs/remove", "/api/local-fs/reveal":
		s.serveLocalFS(w, r)
	case "/api/pane/scrollback", "/api/pane/scrollback/save":
		s.servePaneScrollback(w, r)
	case "/api/pane/screenshot/save":
		s.servePaneScreenshotSave(w, r)
	case "/api/sysmon":
		s.serveSysmon(w, r)
	case "/api/about":
		s.serveAbout(w, r)
	case "/api/update/check":
		s.serveUpdateCheck(w, r, remoteKey)
	case "/api/update/apply-ui":
		s.serveUpdateApplyUI(w, r, remoteKey)
	case "/api/update/prepare-setup":
		s.serveUpdatePrepareSetup(w, r, remoteKey)
	case "/api/update/open-setup":
		s.serveUpdateOpenSetup(w, r, remoteKey)
	case "/api/diag":
		// diagnostico da UI (--diag): so' vai para o log
		b, _ := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<10))
		log.Printf("diag: %s", b)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case "/api/restore/pending":
		restorePendingHandler(s.hub, s.hub.readOnly, s.hub.pendingDeps).ServeHTTP(w, r)
	case "/api/restore/answer":
		restoreAnswerHandler(s.hub, s.hub.readOnly).ServeHTTP(w, r)
	case "/api/wsl-init/test":
		wslInitTestHandler(settings, s.hub.readOnly, func(distro string, cfg WSLInitCfg) {
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
				defer cancel()
				(&hubRestoreEnv{h: s.hub}).TestInit(ctx, distro, cfg)
			}()
		}).ServeHTTP(w, r)
	case "/api/wsl-init":
		wslInitHandler(settings, listWSLDistros, s.hub.readOnly).ServeHTTP(w, r)
	case "/api/content":
		s.serveContent(w, r)
	case "/api/themes", "/api/fonts", "/api/settings", "/api/settings/default", "/api/settings/pane",
		"/api/favorites/theme", "/api/favorites/font", "/api/layout", "/api/settings/ui", "/api/settings/clear-panes", "/api/settings/sidebar", "/api/settings/pane-names":
		s.serveAPI(w, r)
	default:
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			s.serveIndex(w)
			return
		}
		s.static.ServeHTTP(w, r)
	}
}

func (s *server) originOK(o string) bool {
	o = strings.TrimRight(o, "/")
	if o == s.origin || o == fmt.Sprintf("http://localhost:%d", s.port) {
		return true
	}
	return s.devOrigin != "" && o == s.devOrigin
}

// tokenOK accepts the token from ?t=, the X-BethStudio-Token header, or the
// per-port cookie set on the first authenticated page load.
func (s *server) tokenOK(r *http.Request) (fromQuery bool, ok bool) {
	eq := func(v string) bool {
		return v != "" && subtle.ConstantTimeCompare([]byte(v), []byte(s.token)) == 1
	}
	if eq(r.URL.Query().Get("t")) {
		return true, true
	}
	if eq(r.Header.Get(tokenHeader)) {
		return false, true
	}
	if c, err := r.Cookie(s.cookieName); err == nil && eq(c.Value) {
		return false, true
	}
	return false, false
}

// clientRequest is what the browser may send. Only these ops are relayed,
// and they are re-encoded (never passed through raw).
type clientRequest struct {
	Op      string  `json:"op"`
	PaneID  *int    `json:"pane_id"`
	PaneIDs []int   `json:"pane_ids"`
	Data    *string `json:"data"`
	Offset  *int    `json:"offset"`
	ShellID string  `json:"shell_id"`
	Window  *int    `json:"window_id"`
	Cwd     *string `json:"cwd"`
	ReqID   string  `json:"request_id"`
	Cols    *int    `json:"cols"`
	Rows    *int    `json:"rows"`
	Kind    string  `json:"kind"`   // spawn_tool: ssh | serial
	ID      string  `json:"id"`     // spawn_tool: id do host/perfil salvo
	Distro  string  `json:"distro"` // spawn: distro WSL (so' para shells wsl.*)
}

var (
	shellIDRe = regexp.MustCompile(`^[a-z0-9._-]{1,64}$`)
	reqIDRe   = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

func (s *server) serveWS(w http.ResponseWriter, r *http.Request, phoneClient bool) {
	s.serveWSWith(w, r, func(c *client) { c.phone = phoneClient })
}

func (s *server) serveWSWith(w http.ResponseWriter, r *http.Request, setup func(*client)) {
	if r.Header.Get("Origin") == "" {
		http.Error(w, "origem ausente", http.StatusForbidden)
		return
	}
	conn, rw, err := wsUpgrade(w, r)
	if err != nil {
		log.Printf("ws: upgrade: %v", err)
		return
	}
	defer conn.Close()

	c := s.hub.add()
	s.hub.mu.Lock() // remoteCount/dropRemote leem estes campos com o lock
	setup(c)
	s.hub.mu.Unlock()
	defer s.hub.remove(c)

	var wmu sync.Mutex
	write := func(op byte, data []byte) error {
		wmu.Lock()
		defer wmu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return wsWriteFrame(rw.Writer, op, data)
	}
	sendErr := func(msg string) {
		b, _ := json.Marshal(map[string]string{"ev": "error", "message": msg})
		c.enqueue(b)
	}

	// Writer: hub -> browser, plus a keepalive ping.
	go func() {
		t := time.NewTicker(25 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-c.gone:
				_ = conn.Close()
				return
			case m := <-c.out:
				if err := write(wsOpText, m); err != nil {
					c.close()
					return
				}
			case <-t.C:
				if c.remote != "" && !remote.touchKey(c.remote) {
					c.close()
					return
				}
				if err := write(wsOpPing, nil); err != nil {
					c.close()
					return
				}
			}
		}
	}()

	s.readLoop(conn, rw.Reader, c, write, sendErr)
}

func (s *server) readLoop(conn net.Conn, rd *bufio.Reader, c *client, write func(byte, []byte) error, sendErr func(string)) {
	for {
		_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		m, err := wsReadMessage(rd)
		if err != nil {
			return
		}
		switch m.Op {
		case wsOpClose:
			_ = write(wsOpClose, []byte{0x03, 0xe8})
			return
		case wsOpPing:
			_ = write(wsOpPong, m.Data)
			continue
		case wsOpPong:
			continue
		case wsOpText, wsOpBinary:
		default:
			continue
		}
		var req clientRequest
		if err := json.Unmarshal(m.Data, &req); err != nil {
			sendErr("requisição inválida")
			continue
		}
		s.handle(c, req, sendErr)
	}
}

func (s *server) handle(c *client, req clientRequest, sendErr func(string)) {
	if c.phone && !phoneOpAllowed(req.Op) {
		sendErr("operação não disponível no celular")
		return
	}
	// Studio remoto não muda o tamanho dos terminais no host: a janela nativa
	// e o Studio no PC ficariam do tamanho da tela do notebook.
	if c.remote != "" && req.Op == "resize" {
		return
	}
	b := s.hub.bridge
	// Janela SFTP não sobe a ponte. Sem isto, o WebSocket da página (list)
	// chama write num bridge nil e derruba a requisição.
	if b == nil {
		switch req.Op {
		case "list", "watch", "scroll":
			return
		default:
			sendErr("esta janela não está ligada ao Beth Studio")
			return
		}
	}
	// Requisicoes que chegam antes de a ponte subir (a pagina conecta
	// primeiro): list/watch/scroll/shells sao descartadas sem erro (a ponte
	// recebe tudo no resync); acoes do usuario ganham uma mensagem clara.
	quiet := func(err error) {
		if err != nil && !errors.Is(err, errBridgeDown) {
			sendErr(err.Error())
		}
	}
	userErr := func(err error) {
		if errors.Is(err, errBridgeDown) {
			sendErr(msgConnecting)
			return
		}
		sendErr(err.Error())
	}
	switch req.Op {
	case "list":
		// antes da ponte subir: descarta (ela manda a lista ao subir)
		quiet(b.write(map[string]any{"op": "list"}))
	case "watch":
		ids := make([]int, 0, len(req.PaneIDs)+1)
		seen := map[int]bool{}
		add := func(id int) {
			if id >= 0 && !seen[id] && len(ids) < 16 {
				seen[id] = true
				ids = append(ids, id)
			}
		}
		for _, id := range req.PaneIDs {
			add(id)
		}
		if req.PaneID != nil {
			add(*req.PaneID)
		}
		s.hub.setWatch(c, ids)
	case "scroll":
		// Scrollback view (patch 0171): allowed in --read-only, it only
		// changes what the bridge shows, never the pane.
		if req.PaneID == nil || *req.PaneID < 0 || req.Offset == nil || *req.Offset < 0 || *req.Offset > 1_000_000 {
			sendErr("scroll: pane_id e offset (0..1000000) são obrigatórios")
			return
		}
		s.hub.noteScroll(*req.PaneID, *req.Offset) // reaplicado quando a ponte subir
		quiet(b.write(map[string]any{"op": "scroll", "pane_id": *req.PaneID, "offset": *req.Offset}))
	case "separate":
		// Tira o pane do split NO HOST e poe numa aba propria da mesma janela
		// (patch 0182). Nada e' encerrado; depois o web pode ajustar o tamanho.
		if s.hub.readOnly {
			sendErr("modo somente leitura: separar desabilitado")
			return
		}
		if req.PaneID == nil || *req.PaneID < 0 {
			sendErr("separate: pane_id inválido")
			return
		}
		log.Printf("separate: separar o terminal %d do split no Beth Studio, pedido pela interface web", *req.PaneID)
		if err := b.write(map[string]any{"op": "separate", "pane_id": *req.PaneID}); err != nil {
			userErr(err)
		}
	case "kill":
		// Encerra o processo do terminal NO HOST (patch 0180). So' pelo
		// "Encerrar terminal…" confirmado na UI; fechar aba/visualizacao
		// nunca chega aqui.
		if s.hub.readOnly {
			sendErr("modo somente leitura: encerrar terminal desabilitado")
			return
		}
		if req.PaneID == nil || *req.PaneID < 0 {
			sendErr("kill: pane_id inválido")
			return
		}
		log.Printf("kill: encerrar o terminal %d pedido pela interface web (%s)", *req.PaneID, time.Now().Format(time.RFC3339))
		if err := b.write(map[string]any{"op": "kill", "pane_id": *req.PaneID}); err != nil {
			userErr(err)
		}
	case "resize":
		// Changes the pane size IN THE HOST (patch 0178; the GUI shows it
		// too). The bridge only accepts panes alone in their host tab.
		if s.hub.readOnly {
			sendErr("modo somente leitura: redimensionar desabilitado")
			return
		}
		if req.PaneID == nil || *req.PaneID < 0 || req.Cols == nil || req.Rows == nil ||
			*req.Cols < 10 || *req.Cols > 500 || *req.Rows < 4 || *req.Rows > 300 {
			sendErr("resize: pane_id ≥ 0, cols 10–500 e rows 4–300")
			return
		}
		if err := b.write(map[string]any{"op": "resize", "pane_id": *req.PaneID, "cols": *req.Cols, "rows": *req.Rows}); err != nil {
			userErr(err)
		}
	case "shells":
		quiet(b.write(map[string]any{"op": "shells"}))
	case "dismiss_agent":
		if req.PaneID == nil || *req.PaneID < 0 {
			sendErr("pane_id obrigatório")
			return
		}
		s.hub.dismissAgent(*req.PaneID)
	case "spawn":
		// Starts a real terminal in the host (patch 0176).
		if s.hub.readOnly {
			sendErr("modo somente leitura: criar terminal desabilitado")
			return
		}
		if !shellIDRe.MatchString(req.ShellID) {
			sendErr("spawn: shell_id inválido")
			return
		}
		out := map[string]any{"op": "spawn", "shell_id": req.ShellID}
		if req.ReqID != "" {
			if !reqIDRe.MatchString(req.ReqID) {
				sendErr("spawn: request_id inválido")
				return
			}
			out["request_id"] = req.ReqID
		}
		if req.Window != nil {
			if *req.Window < 0 {
				sendErr("spawn: window_id inválido")
				return
			}
			out["window_id"] = *req.Window
		}
		if req.Cwd != nil && *req.Cwd != "" {
			if len(*req.Cwd) > 1024 || strings.ContainsRune(*req.Cwd, 0) {
				sendErr("spawn: cwd inválido")
				return
			}
			out["cwd"] = *req.Cwd
		}
		if req.Distro != "" {
			if !distroRe.MatchString(req.Distro) {
				sendErr("spawn: distro inválida")
				return
			}
			out["distro"] = req.Distro
		}
		send := func() {
			s.hub.noteSpawn(req.ReqID, req.ShellID)
			if err := b.write(out); err != nil {
				userErr(err)
			}
		}
		// Terminal WSL com a distro parada: espera ela responder (e a pasta existir)
		// em vez de correr contra a VM fria (wsl_ready.go).
		if gate := s.hub.wslGate; gate != nil && strings.HasPrefix(req.ShellID, "wsl.") {
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
				defer cancel()
				distro := wslDistroForShell(req.ShellID, req.Distro, listWSLDistros(), defaultWSLDistro())
				if distro != "" {
					if err := gate.Ensure(ctx, distro); err != nil {
						sendErr(spawnErrorWithRequest(req.ReqID, err))
						return
					}
					if cwd, _ := out["cwd"].(string); strings.HasPrefix(cwd, "/") && !gate.WaitDir(ctx, distro, cwd) {
						delete(out, "cwd") // a pasta nao apareceu: abre na home
					}
				}
				send()
			}()
			return
		}
		send()
	case "spawn_tool":
		// Terminal de ferramenta no host (SSH salvo / porta serial). O comando
		// e' montado pela ponte a partir de kind + id validados.
		if s.hub.readOnly {
			sendErr("modo somente leitura: criar terminal desabilitado")
			return
		}
		msg, shellID, err := toolSpawnMessage(req.Kind, req.ID, req.ReqID, req.Window)
		if err != nil {
			sendErr(toolSpawnError(req.ReqID, err))
			return
		}
		s.hub.noteSpawn(req.ReqID, shellID)
		if err := b.write(msg); err != nil {
			userErr(err)
		}
	case "send", "paste":
		if s.hub.readOnly {
			sendErr("modo somente leitura: entrada desabilitada")
			return
		}
		if req.PaneID == nil || *req.PaneID < 0 || req.Data == nil {
			sendErr("pane_id e data são obrigatórios")
			return
		}
		if len(*req.Data) == 0 {
			return
		}
		if len(*req.Data) > maxDataBytes {
			sendErr("texto grande demais")
			return
		}
		if err := b.write(map[string]any{"op": req.Op, "pane_id": *req.PaneID, "data": *req.Data}); err != nil {
			userErr(err)
		}
	default:
		sendErr("operação desconhecida: " + req.Op)
	}
}
