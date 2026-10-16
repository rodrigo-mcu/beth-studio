package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"
)

// hub multiplexes browser connections over the single bridge:
//   - every `list` event goes to every client (and is cached for newcomers);
//   - a `screen` event goes only to clients that watch that pane;
//   - the watched set sent to the bridge is the union of all clients' sets;
//   - the last screen of each watched pane is cached, because the bridge only
//     sends a screen when it changes (a second viewer would wait forever).
type hub struct {
	readOnly bool
	bridge   *bridge
	// janelas de terminal destacadas (term_registry.go)
	term *termRegistry
	// supervisor do host (supervisor.go); nil nos modos --db, --sftp e --term
	sup *supervisor
	// restauracao de terminais depois de uma queda (restore*.go); nil sem supervisor
	restore *restoreCoordinator
	wslGate wslReady

	mu       sync.Mutex
	clients  map[*client]struct{}
	lastList []byte
	screens  map[int][]byte
	union    []int
	status   statusEvent
	content  contentState
	// agents: last {"ev":"agent",...,"waiting":true} per pane (patch 0175).
	// Kept across bridge restarts (a new bridge does not know old alerts);
	// cleared by waiting:false, by typing (the bridge sends reason input)
	// or by "dispensar" in the UI.
	agents map[int][]byte
	shells []byte
	// hostMsg: ultimo {"ev":"host",...} do supervisor, para quem conecta depois
	hostMsg []byte
	// restoreMsg: ultimo {"ev":"restore",...}; spawnWait: request_id -> espera pelo `spawned`
	restoreMsg []byte
	spawnWait  map[string]chan spawnResult
	// initAsk: pergunta "executar o init do WSL?" aberta por distro; initSkip: init em
	// andamento por distro, para "continuar assim mesmo" (restore_init.go)
	initAsk  map[string]chan bool
	initSkip map[string]chan struct{}
	// pendingRetry: retentativa automática dos terminais pendentes (restore_pending.go)
	pendingRetry pendingRetryState
	// rawList: ultima lista da ponte SEM os tipos (para reclassificar
	// quando pane-commands.json muda). spawnReq: request_id -> shell_id.
	rawList  []byte
	spawnReq map[string]string
	// scrollWait: request_id -> canal para POST /api/pane/scrollback (patch 0188).
	scrollWait map[string]chan scrollResult
	offsets    map[int]int
	// paletteSent: last Studio theme pushed to the host (patch 0189).
	paletteSent map[int]string
}

type scrollResult struct {
	Text string
	Err  string
	Pane int
}

type statusEvent struct {
	Ev       string `json:"ev"`
	State    string `json:"state"` // starting | up | down
	Message  string `json:"message"`
	ReadOnly bool   `json:"read_only"`
	Exe      string `json:"exe,omitempty"`
}

// client is one browser WebSocket connection.
type client struct {
	out   chan []byte
	watch map[int]bool
	gone  chan struct{}
	once  sync.Once
	phone bool
	// remote: chave da sessão do Studio remoto ("" = Studio no PC ou celular)
	remote string
}

func (c *client) close() { c.once.Do(func() { close(c.gone) }) }

func newHub(readOnly bool) *hub {
	h := &hub{
		readOnly:   readOnly,
		clients:    map[*client]struct{}{},
		screens:    map[int][]byte{},
		offsets:    map[int]int{},
		spawnReq:   map[string]string{},
		scrollWait: map[string]chan scrollResult{},
		agents:     map[int][]byte{},
		content:    contentState{cache: map[int]cachedText{}},
		status:     statusEvent{Ev: "status", State: "starting", Message: "iniciando", ReadOnly: readOnly},
	}
	h.term = newTermRegistry(func(panes []int) {
		h.broadcast(map[string]any{"ev": "term_windows", "panes": panes})
	})
	return h
}

func (h *hub) add() *client {
	c := &client{out: make(chan []byte, 512), watch: map[int]bool{}, gone: make(chan struct{})}
	h.mu.Lock()
	h.clients[c] = struct{}{}
	st := h.statusJSONLocked()
	list := h.lastList
	var agents [][]byte
	for _, a := range h.agents {
		agents = append(agents, a)
	}
	shells := h.shells
	hostMsg := h.hostMsg
	restoreMsg := h.restoreMsg
	h.mu.Unlock()
	c.enqueue(st)
	if hostMsg != nil {
		c.enqueue(hostMsg)
	}
	if restoreMsg != nil {
		c.enqueue(restoreMsg)
	}
	if list != nil {
		c.enqueue(list)
	}
	// Current "agent waiting" state for a browser that just connected.
	for _, a := range agents {
		c.enqueue(a)
	}
	if shells != nil {
		c.enqueue(shells)
	}
	return c
}

// remoteCount: Studios remotos conectados agora (aviso no Studio do PC).
func (h *hub) remoteCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for c := range h.clients {
		if c.remote != "" {
			n++
		}
	}
	return n
}

// dropRemote fecha as conexões das sessões remotas encerradas.
func (h *hub) dropRemote(gone func(key string) bool) {
	h.mu.Lock()
	var out []*client
	for c := range h.clients {
		if c.remote != "" && gone(c.remote) {
			out = append(out, c)
		}
	}
	h.mu.Unlock()
	for _, c := range out {
		c.close()
	}
}

func (h *hub) remove(c *client) {
	h.mu.Lock()
	delete(h.clients, c)
	h.mu.Unlock()
	c.close()
	h.syncWatch()
}

// enqueue never blocks: a client that cannot keep up is dropped (the page
// reconnects and gets a fresh list + screens).
func (c *client) enqueue(msg []byte) {
	select {
	case <-c.gone:
	case c.out <- msg:
	default:
		log.Printf("hub: cliente lento, desconectando")
		c.close()
	}
}

func (h *hub) statusJSONLocked() []byte {
	h.status.Exe = ""
	if h.bridge != nil {
		h.status.Exe = h.bridge.exe
	}
	b, _ := json.Marshal(h.status)
	return b
}

// setHost guarda e transmite o estado do host visto pelo supervisor.
func (h *hub) setHost(state hostState, msg string) {
	b, err := json.Marshal(map[string]any{"ev": "host", "state": string(state), "message": msg})
	if err != nil {
		return
	}
	h.mu.Lock()
	h.hostMsg = b
	cs := h.clientsLocked()
	h.mu.Unlock()
	for _, c := range cs {
		c.enqueue(b)
	}
}

func (h *hub) setStatus(state, msg string) {
	h.mu.Lock()
	if h.status.State == state && h.status.Message == msg {
		h.mu.Unlock()
		return
	}
	h.status.State = state
	h.status.Message = msg
	b := h.statusJSONLocked()
	cs := h.clientsLocked()
	h.mu.Unlock()
	for _, c := range cs {
		c.enqueue(b)
	}
}

// broadcast sends one event to every client.
func (h *hub) broadcast(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	h.mu.Lock()
	cs := h.clientsLocked()
	h.mu.Unlock()
	for _, c := range cs {
		c.enqueue(b)
	}
}

func (h *hub) clientsLocked() []*client {
	cs := make([]*client, 0, len(h.clients))
	for c := range h.clients {
		cs = append(cs, c)
	}
	return cs
}

// bridgeGone: forget cached screens (a new bridge re-sends them).
func (h *hub) bridgeGone() {
	h.mu.Lock()
	h.screens = map[int][]byte{}
	h.mu.Unlock()
}

type bridgeEvent struct {
	Ev      string `json:"ev"`
	PaneID  *int   `json:"pane_id"`
	Message string `json:"message"`
}

// fromBridge routes one event line from the bridge and returns it parsed
// (the bridge uses it for its health check).
func (h *hub) fromBridge(line []byte) (ev bridgeEvent) {
	if err := json.Unmarshal(line, &ev); err != nil {
		log.Printf("bridge: linha inválida (%d bytes): %v", len(line), err)
		return
	}
	msg := append([]byte(nil), line...)
	if ev.Ev == "list" {
		// Tipo de cada terminal (panekind.go) vai junto na lista.
		msg = enrichList(line, guiCommands.get(dataDir()), settings.spawnedMap())
		// antes do reconcile: se o host e' novo e vazio, congela o reconcile e restaura
		if h.restore != nil {
			h.restore.onList(msg)
		}
	}
	if ev.Ev == "spawned" {
		var sp struct {
			RequestID string `json:"request_id"`
			PaneID    int    `json:"pane_id"`
		}
		if json.Unmarshal(line, &sp) == nil && sp.RequestID != "" {
			h.mu.Lock()
			sh := h.spawnReq[sp.RequestID]
			delete(h.spawnReq, sp.RequestID)
			h.mu.Unlock()
			if sh != "" {
				settings.recordSpawn(sp.PaneID, sh)
				defer h.refreshKinds(true)
			}
			h.notifySpawn(sp.RequestID, spawnResult{PaneID: sp.PaneID})
		}
	}
	if ev.Ev == "scrollback" {
		var sb struct {
			RequestID string `json:"request_id"`
			PaneID    int    `json:"pane_id"`
			Text      string `json:"text"`
		}
		if json.Unmarshal(line, &sb) == nil && sb.RequestID != "" {
			h.mu.Lock()
			ch := h.scrollWait[sb.RequestID]
			delete(h.scrollWait, sb.RequestID)
			h.mu.Unlock()
			if ch != nil {
				select {
				case ch <- scrollResult{Text: sb.Text, Pane: sb.PaneID}:
				default:
				}
			}
		}
		return ev // nao espalha megabytes de historico para todos os clients
	}
	if ev.Ev == "error" && strings.HasPrefix(ev.Message, "spawn") {
		// "spawn <shell> (request r1): erro": quem espera pelo spawn recebe o motivo
		if rid := spawnErrRequestID(ev.Message); rid != "" && h.notifySpawn(rid, spawnResult{Err: ev.Message}) {
			return ev
		}
	}
	if ev.Ev == "error" && strings.Contains(strings.ToLower(ev.Message), "scrollback pane") {
		// "scrollback pane N (request r1): ..." — entrega ao waiter
		rid := scrollbackReqFromErr(ev.Message)
		if rid != "" {
			h.mu.Lock()
			ch := h.scrollWait[rid]
			delete(h.scrollWait, rid)
			h.mu.Unlock()
			if ch != nil {
				select {
				case ch <- scrollResult{Err: ev.Message}:
				default:
				}
				return ev
			}
		}
	}
	h.mu.Lock()
	var targets []*client
	switch ev.Ev {
	case "list":
		h.rawList = append([]byte(nil), line...)
		h.lastList = msg
		targets = h.clientsLocked()
		go settings.reconcile(msg)
		go h.syncPalettes()
	case "agent":
		if ev.PaneID != nil {
			var a struct {
				Waiting bool `json:"waiting"`
			}
			_ = json.Unmarshal(line, &a)
			if a.Waiting {
				h.agents[*ev.PaneID] = msg
			} else {
				delete(h.agents, *ev.PaneID)
			}
		}
		targets = h.clientsLocked()
	case "shells":
		h.shells = msg
		targets = h.clientsLocked()
	case "pane_gone":
		// Patch 0179: o pane fechou (a ponte ja' tirou do watch e reenvia a
		// lista). Esquece tela, aviso de agente e cache de conteudo.
		if ev.PaneID != nil {
			delete(h.offsets, *ev.PaneID)
			delete(h.screens, *ev.PaneID)
			delete(h.agents, *ev.PaneID)
			delete(h.content.cache, *ev.PaneID)
			delete(h.paletteSent, *ev.PaneID)
		}
		targets = h.clientsLocked()
	case "error":
		// Pontes antigas (antes da 0179) mandam "no such pane" quando um
		// terminal observado fecha: nao e' erro para o usuario.
		if strings.Contains(strings.ToLower(ev.Message), "no such pane") {
			log.Printf("bridge: %s (terminal fechado; aviso omitido)", ev.Message)
			break
		}
		targets = h.clientsLocked()
	case "screen":
		if ev.PaneID == nil {
			h.mu.Unlock()
			return ev
		}
		id := *ev.PaneID
		watched := false
		for c := range h.clients {
			if c.watch[id] {
				targets = append(targets, c)
				watched = true
			}
		}
		if watched {
			h.screens[id] = msg
		}
		h.onScreenForContentLocked(id, msg)
	default: // error and anything new: everyone sees it
		targets = h.clientsLocked()
	}
	h.mu.Unlock()
	for _, c := range targets {
		c.enqueue(msg)
	}
	return ev
}

// setWatch replaces one client's watched set, pushes the new union to the
// bridge and immediately replays cached screens for panes it just added.
func (h *hub) setWatch(c *client, ids []int) {
	h.mu.Lock()
	next := map[int]bool{}
	var replay [][]byte
	for _, id := range ids {
		next[id] = true
		if !c.watch[id] {
			if s, ok := h.screens[id]; ok {
				replay = append(replay, s)
			}
		}
	}
	c.watch = next
	h.mu.Unlock()
	for _, s := range replay {
		c.enqueue(s)
	}
	h.syncWatch()
}

func (h *hub) watchUnion() []int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]int(nil), h.union...)
}

func (h *hub) syncWatch() {
	h.mu.Lock()
	set := map[int]bool{}
	for c := range h.clients {
		for id := range c.watch {
			set[id] = true
		}
	}
	ids := make([]int, 0, len(set))
	for id := range set {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	changed := !equalInts(ids, h.union)
	h.union = ids
	for id := range h.screens {
		if !set[id] {
			delete(h.screens, id)
		}
	}
	h.mu.Unlock()
	if changed && h.bridge != nil {
		if err := h.bridge.write(map[string]any{"op": "watch", "pane_ids": ids}); err != nil {
			log.Printf("hub: watch não enviado: %v", err)
		}
	}
}

func equalInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// dismissAgent: the user clicked "dispensar" (UI only; the bridge is not
// told, a new alert from the pane shows up again).
func (h *hub) dismissAgent(pane int) {
	h.mu.Lock()
	_, had := h.agents[pane]
	delete(h.agents, pane)
	h.mu.Unlock()
	if had {
		h.broadcast(map[string]any{"ev": "agent", "pane_id": pane, "waiting": false, "reason": "dismissed"})
	}
}

// noteSpawn guarda o shell de um spawn pedido pelo web (para o tipo).
func (h *hub) noteSpawn(reqID, shellID string) {
	if reqID == "" {
		return
	}
	h.mu.Lock()
	if len(h.spawnReq) > 100 {
		h.spawnReq = map[string]string{}
	}
	h.spawnReq[reqID] = shellID
	h.mu.Unlock()
}

// refreshKinds reclassifica a ultima lista (pane-commands.json mudou ou um
// spawn do web foi registrado) e manda de novo se algo mudou.
func (h *hub) refreshKinds(force bool) {
	h.mu.Lock()
	raw := h.rawList
	old := h.lastList
	h.mu.Unlock()
	if raw == nil {
		return
	}
	msg := enrichList(raw, guiCommands.get(dataDir()), settings.spawnedMap())
	if !force && bytes.Equal(msg, old) {
		return
	}
	if bytes.Equal(msg, old) {
		return
	}
	h.mu.Lock()
	h.lastList = msg
	cs := h.clientsLocked()
	h.mu.Unlock()
	for _, c := range cs {
		c.enqueue(msg)
	}
}

func (h *hub) noteScroll(pane, offset int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if offset <= 0 {
		delete(h.offsets, pane)
	} else {
		h.offsets[pane] = offset
	}
}

func (h *hub) scrollOffsets() map[int]int {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make(map[int]int, len(h.offsets))
	inUnion := map[int]bool{}
	for _, id := range h.union {
		inUnion[id] = true
	}
	for p, o := range h.offsets {
		if inUnion[p] {
			out[p] = o
		}
	}
	return out
}

// scrollbackReqFromErr: "scrollback pane 9 (request r1): ..." -> "r1"
func scrollbackReqFromErr(msg string) string {
	const marker = "(request "
	i := strings.Index(msg, marker)
	if i < 0 {
		return ""
	}
	rest := msg[i+len(marker):]
	j := strings.IndexByte(rest, ')')
	if j <= 0 {
		return ""
	}
	return strings.TrimSpace(rest[:j])
}

// requestScrollback pede o historico completo a ponte e espera a resposta.
func (h *hub) requestScrollback(paneID int, timeout time.Duration) (string, error) {
	if h.bridge == nil {
		return "", errors.New("ponte indisponível")
	}
	rid := fmt.Sprintf("sb%d", time.Now().UnixNano())
	ch := make(chan scrollResult, 1)
	h.mu.Lock()
	h.scrollWait[rid] = ch
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.scrollWait, rid)
		h.mu.Unlock()
	}()
	if err := h.bridge.write(map[string]any{
		"op": "scrollback", "pane_id": paneID, "request_id": rid,
	}); err != nil {
		return "", err
	}
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case r := <-ch:
		if r.Err != "" {
			return "", errors.New(r.Err)
		}
		return r.Text, nil
	case <-t.C:
		return "", errors.New("tempo esgotado ao ler o histórico")
	}
}
