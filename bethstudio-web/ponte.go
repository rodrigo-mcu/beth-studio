package main

// ponte.go — ponte de agentes (Claude do Windows <-> Claude do WSL2) pelo
// Studio. Desenho: docs/superpowers/specs/2026-10-31-ponte-agentes-design.md.
//
// O Studio é o carteiro: guarda em memória quem está na ponte e as filas de
// mensagens. Cada agente fala com ele pelo servidor MCP `bethstudio-tool.exe
// ponte-mcp` (ponte_mcp.go), que acha o Studio pelo arquivo <dados>\ponte.json
// (url + token). No WSL, o Claude roda esse mesmo .exe pelo interop: o
// processo é do Windows e chega em 127.0.0.1 sem passar pela rede do WSL.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	ponteServerName = "beth-ponte"
	ponteFileName   = "ponte.json"
	ponteMaxText    = 200_000
	ponteMaxQueue   = 100
	ponteStale      = 75 * time.Second // o laço do MCP renova a cada 20 s
	ponteMaxWait    = 25 * time.Second
)

// PonteSettings fica em web-settings.json ("ponte").
type PonteSettings struct {
	Enabled bool `json:"enabled"`
}

func (st *settingsStore) ponte() PonteSettings {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.s.Ponte == nil {
		return PonteSettings{}
	}
	return *st.s.Ponte
}

func (st *settingsStore) setPonte(p PonteSettings) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.s.Ponte = &p
	return st.saveLocked()
}

// ---------------------------------------------------------------------------
// quadro de mensagens
// ---------------------------------------------------------------------------

type ponteMsg struct {
	ID       int64  `json:"id"`
	From     string `json:"from"`
	FromSide string `json:"from_side"`
	To       string `json:"to"`
	Text     string `json:"text"`
	At       int64  `json:"at"` // unix ms
}

type ponteAgent struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Side  string `json:"side"` // windows | wsl
	Cwd   string `json:"cwd"`
	PID   int    `json:"pid"`
	Since int64  `json:"since"`
	Seen  int64  `json:"seen"`
	queue []ponteMsg
	wake  chan struct{}
	// maior id de mensagem entregue a este agente e maior já lida pelo modelo
	// (ponte_aguardar avisa por /ack). Entregue > lida = há mensagem não lida:
	// é o que o hook "ouvir sozinho" espera para acordar a sessão.
	lastSent, lastRead int64
}

type ponteHub struct {
	mu     sync.Mutex
	agents map[string]*ponteAgent
	seq    int64
	now    func() time.Time
}

func newPonteHub() *ponteHub {
	return &ponteHub{agents: map[string]*ponteAgent{}, now: time.Now}
}

// ponteDefaultish: nome gerado pela pasta ("windows", "wsl-mobi-server").
func ponteDefaultish(name, side string) bool {
	return name == side || strings.HasPrefix(name, side+"-")
}

func normSide(s string) string {
	if strings.EqualFold(strings.TrimSpace(s), "wsl") {
		return "wsl"
	}
	return "windows"
}

// pruneLocked tira quem não dá sinal de vida há ponteStale.
func (h *ponteHub) pruneLocked() {
	cut := h.now().Add(-ponteStale).UnixMilli()
	for id, a := range h.agents {
		if a.Seen < cut {
			delete(h.agents, id)
		}
	}
}

func (h *ponteHub) nameTakenLocked(name, exceptID string) bool {
	for _, a := range h.agents {
		if a.ID != exceptID && strings.EqualFold(a.Name, name) {
			return true
		}
	}
	return false
}

// register entra na ponte. Com o id de antes (o Studio reiniciou ou o laço
// voltou) mantém a fila e, se der, o mesmo nome.
func (h *ponteHub) register(id, name, side, cwd string, pid int) *ponteAgent {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.pruneLocked()
	side = normSide(side)
	name = cleanAgentName(name)
	if name == "" {
		name = side
	}
	now := h.now().UnixMilli()
	a := h.agents[id]
	if id == "" || a == nil {
		if id == "" {
			id = randomToken()[:16]
		}
		a = &ponteAgent{ID: id, Since: now, wake: make(chan struct{}, 1)}
		h.agents[id] = a
	}
	base, n := name, 2
	for h.nameTakenLocked(name, id) {
		name = fmt.Sprintf("%s %d", base, n)
		n++
	}
	a.Name, a.Side, a.Cwd, a.PID, a.Seen = name, side, cwd, pid, now
	cp := *a
	return &cp
}

func (h *ponteHub) bye(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.agents, id)
}

// list: agentes vivos, por lado e nome.
func (h *ponteHub) list() []ponteAgent {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.pruneLocked()
	out := make([]ponteAgent, 0, len(h.agents))
	for _, a := range h.agents {
		cp := *a
		cp.queue, cp.wake = nil, nil
		out = append(out, cp)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Side != out[j].Side {
			return out[i].Side < out[j].Side
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out
}

var errPonteUnknown = errors.New("agente desconhecido: entre na ponte de novo")

// ponteFolderBase: último nome da pasta de trabalho (Windows, WSL ou UNC).
func ponteFolderBase(cwd string) string {
	c := strings.TrimRight(strings.ReplaceAll(cwd, `\`, "/"), "/")
	if i := strings.LastIndexByte(c, '/'); i >= 0 {
		c = c[i+1:]
	}
	return c
}

// ponteLabel: "MOBI VMS (windows) — mobi", para listas em que a pessoa escolhe.
func ponteLabel(a *ponteAgent) string {
	l := a.Name + " (" + a.Side + ")"
	if f := ponteFolderBase(a.Cwd); f != "" {
		l += " — " + f
	}
	return l
}

// resolveLocked acha o destino pelo que a pessoa disse, do mais exato ao mais
// solto, e devolve o primeiro grupo que tiver alguém:
//  1. nome igual (sem ligar para maiúsculas);
//  2. nome igual ignorando espaços, traços, acentos ("mobi-vms" = "MOBI VMS");
//  3. "wsl" ou "windows": os agentes daquele lado;
//  4. o nome está dentro do que foi dito, ou o contrário ("agente MOBI VMS");
//  5. a pasta de trabalho bate ("mobi-server").
//
// Nunca o próprio remetente.
func (h *ponteHub) resolveLocked(target, fromID string) []*ponteAgent {
	raw := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(target), "@"))
	t := normKey(raw)
	var exact, key, side, nameIn, nameOut, folderEq, folderIn, folderOut []*ponteAgent
	nameInLen, folderInLen := map[string]int{}, map[string]int{}
	for _, a := range h.agents {
		if a.ID == fromID {
			continue
		}
		n := normKey(a.Name)
		f := normKey(ponteFolderBase(a.Cwd))
		switch {
		case strings.EqualFold(a.Name, raw):
			exact = append(exact, a)
		case t != "" && n == t:
			key = append(key, a)
		case (t == "wsl" || t == "wsl2" || t == "linux") && a.Side == "wsl",
			(t == "windows" || t == "win") && a.Side == "windows":
			side = append(side, a)
		case len(n) >= 3 && len(t) > len(n) && strings.Contains(t, n): // o nome está dentro do que foi dito
			nameIn = append(nameIn, a)
			nameInLen[a.ID] = len(n)
		case len(t) >= 3 && len(n) > len(t) && strings.Contains(n, t): // o que foi dito é parte do nome
			nameOut = append(nameOut, a)
		case len(t) >= 3 && f == t:
			folderEq = append(folderEq, a)
		case len(f) >= 4 && len(t) > len(f) && strings.Contains(t, f): // a pasta está dentro do que foi dito
			folderIn = append(folderIn, a)
			folderInLen[a.ID] = len(f)
		case len(t) >= 3 && len(f) > len(t) && strings.Contains(f, t):
			folderOut = append(folderOut, a)
		}
	}
	// "dentro do que foi dito": vale o mais específico (a chave mais longa);
	// senão "mobi" (a pasta) empata com "mobi-server" (o que a pessoa disse).
	longest := func(l []*ponteAgent, size map[string]int) []*ponteAgent {
		max := 0
		for _, a := range l {
			if size[a.ID] > max {
				max = size[a.ID]
			}
		}
		var out []*ponteAgent
		for _, a := range l {
			if size[a.ID] == max {
				out = append(out, a)
			}
		}
		return out
	}
	for _, l := range [][]*ponteAgent{exact, key, side, longest(nameIn, nameInLen), nameOut, folderEq, longest(folderIn, folderInLen), folderOut} {
		if len(l) > 0 {
			sort.Slice(l, func(i, j int) bool { return l[i].Name < l[j].Name })
			return l
		}
	}
	return nil
}

type ponteSendErr struct {
	msg   string
	names []string
}

func (e *ponteSendErr) Error() string { return e.msg }

func (h *ponteHub) send(fromID, target, text string) (ponteMsg, error) {
	if strings.TrimSpace(text) == "" {
		return ponteMsg{}, errors.New("mensagem vazia")
	}
	if len(text) > ponteMaxText {
		return ponteMsg{}, fmt.Errorf("mensagem grande demais (%d caracteres; máx. %d): mande um caminho de arquivo", len(text), ponteMaxText)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.pruneLocked()
	from := h.agents[fromID]
	if from == nil {
		return ponteMsg{}, errPonteUnknown
	}
	from.Seen = h.now().UnixMilli()
	to := h.resolveLocked(target, fromID)
	others := func() []string {
		var n []string
		for _, a := range h.agents {
			if a.ID != fromID {
				n = append(n, ponteLabel(a))
			}
		}
		sort.Strings(n)
		return n
	}
	switch {
	case len(to) == 0:
		o := others()
		if len(o) == 0 {
			return ponteMsg{}, &ponteSendErr{msg: "ninguém mais está na ponte agora. Abra o Claude do outro lado (com a ponte registrada nele) e tente de novo."}
		}
		return ponteMsg{}, &ponteSendErr{msg: fmt.Sprintf("ninguém responde por %q. Na ponte agora:\n- %s\nRepita ponte_enviar com o nome de um deles (só o nome, sem o lado e a pasta).", target, strings.Join(o, "\n- ")), names: o}
	case len(to) > 1:
		var n []string
		for _, a := range to {
			n = append(n, ponteLabel(a))
		}
		return ponteMsg{}, &ponteSendErr{msg: "mais de um agente responde por " + fmt.Sprintf("%q", target) + ":\n- " + strings.Join(n, "\n- ") +
			"\nNada foi enviado. Se a pessoa já disse qual é, use esse nome exato; senão pergunte a ela qual.", names: n}
	}
	dst := to[0]
	h.seq++
	m := ponteMsg{ID: h.seq, From: from.Name, FromSide: from.Side, To: dst.Name, Text: text, At: h.now().UnixMilli()}
	dst.lastSent = m.ID
	dst.queue = append(dst.queue, m)
	if len(dst.queue) > ponteMaxQueue {
		dst.queue = dst.queue[len(dst.queue)-ponteMaxQueue:]
	}
	select {
	case dst.wake <- struct{}{}:
	default:
	}
	return m, nil
}

// ack: o modelo leu as mensagens até o id `upto`.
func (h *ponteHub) ack(id string, upto int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if a := h.agents[id]; a != nil && upto > a.lastRead {
		a.lastRead = upto
	}
}

// unread: registered=false se o agente não está na ponte; n = mensagens
// entregues ainda não lidas pelo modelo (0 ou 1: só importa se há alguma).
func (h *ponteHub) unread(id string) (registered bool, n int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	a := h.agents[id]
	if a == nil {
		return false, 0
	}
	if a.lastSent > a.lastRead {
		return true, 1
	}
	return true, 0
}

// notifyWait espera até `timeout` por mensagem não lida (sem consumir nada e
// sem renovar o sinal de vida: quem espera aqui é o hook, não o agente).
func (h *ponteHub) notifyWait(ctx context.Context, id string, timeout time.Duration) (bool, int) {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	tick := time.NewTicker(400 * time.Millisecond)
	defer tick.Stop()
	for {
		reg, n := h.unread(id)
		if !reg || n > 0 {
			return reg, n
		}
		select {
		case <-tick.C:
		case <-deadline.C:
			return true, 0
		case <-ctx.Done():
			return true, 0
		}
	}
}

// wait devolve a fila do agente; vazia, espera até timeout ou ctx.
func (h *ponteHub) wait(ctx context.Context, id string, timeout time.Duration) ([]ponteMsg, error) {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		h.mu.Lock()
		a := h.agents[id]
		if a == nil {
			h.mu.Unlock()
			return nil, errPonteUnknown
		}
		a.Seen = h.now().UnixMilli()
		if len(a.queue) > 0 {
			q := a.queue
			a.queue = nil
			h.mu.Unlock()
			return q, nil
		}
		wake := a.wake
		h.mu.Unlock()
		select {
		case <-wake:
		case <-deadline.C:
			return []ponteMsg{}, nil
		case <-ctx.Done():
			return []ponteMsg{}, nil
		}
	}
}

var ponte = newPonteHub()

// ---------------------------------------------------------------------------
// arquivo de descoberta (<dados>\ponte.json)
// ---------------------------------------------------------------------------

type ponteDiscovery struct {
	URL   string `json:"url"`
	Token string `json:"token"`
	PID   int    `json:"pid"`
}

var ponteAddr struct {
	mu        sync.Mutex
	url, tok  string
	dir       string
	published bool
}

// ponteSetAddr: chamado pelo main depois de abrir a porta.
func ponteSetAddr(dir, url, token string) {
	ponteAddr.mu.Lock()
	ponteAddr.dir, ponteAddr.url, ponteAddr.tok = dir, url, token
	ponteAddr.mu.Unlock()
	ponteSync(settings.ponte().Enabled)
}

// ponteSync grava ou apaga o ponte.json conforme a ponte esteja ligada.
func ponteSync(enabled bool) {
	ponteAddr.mu.Lock()
	defer ponteAddr.mu.Unlock()
	if ponteAddr.dir == "" || ponteAddr.url == "" {
		return
	}
	p := filepath.Join(ponteAddr.dir, ponteFileName)
	if enabled {
		b, _ := json.Marshal(ponteDiscovery{URL: ponteAddr.url, Token: ponteAddr.tok, PID: os.Getpid()})
		_ = os.MkdirAll(ponteAddr.dir, 0o755)
		tmp := p + ".tmp"
		if err := os.WriteFile(tmp, b, 0o600); err == nil {
			_ = os.Rename(tmp, p)
			ponteAddr.published = true
		}
		return
	}
	ponteRemoveOwnLocked(p)
}

// ponteUnpublish: ao sair, apaga o arquivo só se ele ainda é deste Studio.
func ponteUnpublish() {
	ponteAddr.mu.Lock()
	defer ponteAddr.mu.Unlock()
	if ponteAddr.dir != "" {
		ponteRemoveOwnLocked(filepath.Join(ponteAddr.dir, ponteFileName))
	}
}

func ponteRemoveOwnLocked(p string) {
	b, err := os.ReadFile(p)
	if err != nil {
		return
	}
	var d ponteDiscovery
	if json.Unmarshal(b, &d) == nil && d.PID == os.Getpid() {
		_ = os.Remove(p)
	}
	ponteAddr.published = false
}

// ---------------------------------------------------------------------------
// registrar o servidor MCP no Claude (Windows e WSL)
// ---------------------------------------------------------------------------

// ponteToolPath: o bethstudio-tool.exe ao lado deste programa.
func ponteToolPath() string {
	self, err := os.Executable()
	if err != nil {
		return ""
	}
	p := filepath.Join(filepath.Dir(self), "bethstudio-tool.exe")
	if st, err := os.Stat(p); err == nil && !st.IsDir() {
		return p
	}
	return ""
}

func shSingleQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func winQuote(s string) string { return `"` + s + `"` }

// ponteCommands: o que o usuário cola em cada lado (e o que o Studio roda).
func ponteCommands(tool string) (win, wsl, wslPush, winPush string) {
	win = "claude mcp add --scope user " + ponteServerName + " -- " + winQuote(tool) + " ponte-mcp"
	// WSLENV: sem isto o .exe do Windows não recebe o id da sessão do Claude do WSL
	// (e, com ele, o nome da sessão e o "ouvir sozinho" não funcionam).
	wsl = "claude mcp add --scope user " + ponteServerName + " -e WSLENV=CLAUDE_CODE_SESSION_ID -- " + shSingleQuote(windowsPathToWSLMount(tool)) + " ponte-mcp --lado wsl"
	winPush = "claude --dangerously-load-development-channels server:" + ponteServerName
	wslPush = winPush
	return
}

// claudeExe: o claude.exe do Windows (PATH ou o instalador nativo).
func claudeExe() string {
	if p, err := exec.LookPath("claude"); err == nil {
		return p
	}
	if up := os.Getenv("USERPROFILE"); up != "" {
		p := filepath.Join(up, ".local", "bin", "claude.exe")
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

var ponteRun = func(ctx context.Context, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	hideChildWindow(&cmd.SysProcAttr)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(strings.ReplaceAll(string(out), "\x00", "")), err
}

// ponteHookSettingsPath: o settings.json de usuário do Claude em cada lado.
func ponteHookSettingsPath(ctx context.Context, target, distro string) (string, error) {
	switch target {
	case "windows":
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return "", errors.New("não achei a pasta do usuário")
		}
		return filepath.Join(home, ".claude", "settings.json"), nil
	case "wsl":
		if !safeDistroName(distro) {
			return "", errors.New("distro do WSL inválida")
		}
		out, err := ponteRun(ctx, "wsl.exe", "-d", distro, "--", "sh", "-c", "printf %s \"$HOME\"")
		home := strings.TrimSpace(ponteCleanBashNoise(out))
		if err != nil || !strings.HasPrefix(home, "/") || strings.ContainsAny(home, "\r\n") {
			return "", errors.New("não consegui descobrir a pasta do usuário no WSL")
		}
		unc := `\\wsl.localhost\` + distro + strings.ReplaceAll(home, "/", `\`) + `\.claude\settings.json`
		return unc, nil
	}
	return "", errors.New("destino inválido")
}

// ponteSetupHook: ligar/desligar/verificar o "ouvir sozinho" (hook) num lado.
func ponteSetupHook(ctx context.Context, target, distro, action string) (bool, string, error) {
	tool := ponteToolPath()
	if tool == "" && action == "hook-add" {
		return false, "", errors.New("não achei o bethstudio-tool.exe ao lado do Studio")
	}
	path, err := ponteHookSettingsPath(ctx, target, distro)
	if err != nil {
		return false, "", err
	}
	op := strings.TrimPrefix(action, "hook-")
	on, msg, err := ponteHookApply(path, op, ponteHookCommand(tool, target == "wsl"))
	if err != nil {
		return false, "", err
	}
	if op == "check" {
		if on {
			msg = "Ligado neste lado."
		} else {
			msg = "Desligado neste lado."
		}
	}
	return on, msg + "\n(" + path + ")", nil
}

// ponteSetup: action add | remove | check, em "windows" ou "wsl" (distro).
// hook-add | hook-remove | hook-check tratam o "ouvir sozinho".
func ponteSetup(ctx context.Context, target, distro, action string) (bool, string, error) {
	if strings.HasPrefix(action, "hook-") {
		return ponteSetupHook(ctx, target, distro, action)
	}
	tool := ponteToolPath()
	if tool == "" && action == "add" {
		return false, "", errors.New("não achei o bethstudio-tool.exe ao lado do Studio")
	}
	win, wsl, _, _ := ponteCommands(tool)
	switch target {
	case "windows":
		c := claudeExe()
		if c == "" {
			return false, "", errors.New("não achei o Claude Code no Windows (comando claude). Instale-o ou cole o comando à mão.")
		}
		switch action {
		case "check":
			out, err := ponteRun(ctx, c, "mcp", "get", ponteServerName)
			return err == nil, out, nil
		case "remove":
			out, err := ponteRun(ctx, c, "mcp", "remove", "--scope", "user", ponteServerName)
			return false, out, err
		case "add":
			_, _ = ponteRun(ctx, c, "mcp", "remove", "--scope", "user", ponteServerName)
			out, err := ponteRun(ctx, c, "mcp", "add", "--scope", "user", ponteServerName, "--", tool, "ponte-mcp")
			_ = win
			return err == nil, out, err
		}
	case "wsl":
		if !safeDistroName(distro) {
			return false, "", errors.New("distro do WSL inválida")
		}
		var script string
		switch action {
		case "check":
			script = "command -v claude >/dev/null || { echo 'Claude Code não encontrado neste WSL'; exit 3; }; claude mcp get " + ponteServerName
		case "remove":
			script = "claude mcp remove --scope user " + ponteServerName
		case "add":
			script = "command -v claude >/dev/null || { echo 'Claude Code não encontrado neste WSL'; exit 3; }; " +
				"claude mcp remove --scope user " + ponteServerName + " >/dev/null 2>&1; " + wsl
		default:
			return false, "", errors.New("ação inválida")
		}
		// -i: o PATH do nvm costuma vir do .bashrc
		out, err := ponteRun(ctx, "wsl.exe", "-d", distro, "--", "bash", "-lic", script)
		return err == nil && action != "remove", ponteCleanBashNoise(out), func() error {
			if action == "check" {
				return nil
			}
			return err
		}()
	}
	return false, "", errors.New("destino inválido")
}

// ponteCleanBashNoise tira os avisos do bash interativo sem terminal.
func ponteCleanBashNoise(s string) string {
	var keep []string
	for _, l := range strings.Split(s, "\n") {
		t := strings.TrimSpace(l)
		if strings.HasPrefix(t, "bash: cannot set terminal process group") || strings.HasPrefix(t, "bash: no job control") {
			continue
		}
		keep = append(keep, strings.TrimRight(l, "\r"))
	}
	return strings.TrimSpace(strings.Join(keep, "\n"))
}

// ---------------------------------------------------------------------------
// HTTP: /api/ponte/*
// ---------------------------------------------------------------------------

type ponteView struct {
	Enabled  bool              `json:"enabled"`
	Agents   []ponteAgent      `json:"agents"`
	ToolPath string            `json:"tool_path"`
	Distros  []string          `json:"distros"`
	Commands map[string]string `json:"commands"`
}

func (s *server) servePonte(w http.ResponseWriter, r *http.Request, remoteKey string) {
	if remoteKey != "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "A ponte de agentes só existe no Studio deste computador."})
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/ponte")
	// tela de Configurações
	switch path {
	case "", "/":
		tool := ponteToolPath()
		win, wsl, wslPush, winPush := ponteCommands(tool)
		distros := listWSLDistros()
		if distros == nil {
			distros = []string{}
		}
		writeJSON(w, http.StatusOK, ponteView{
			Enabled: settings.ponte().Enabled, Agents: ponte.list(), ToolPath: tool, Distros: distros,
			Commands: map[string]string{"windows": win, "wsl": wsl, "windows_push": winPush, "wsl_push": wslPush},
		})
		return
	case "/enable":
		var body struct {
			Enabled bool `json:"enabled"`
		}
		if r.Method != http.MethodPost || json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body) != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "pedido inválido"})
			return
		}
		if err := settings.setPonte(PonteSettings{Enabled: body.Enabled}); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		ponteSync(body.Enabled)
		writeJSON(w, http.StatusOK, map[string]bool{"enabled": body.Enabled})
		return
	case "/setup":
		if s.hub != nil && s.hub.readOnly {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "modo somente leitura"})
			return
		}
		var body struct {
			Target string `json:"target"`
			Distro string `json:"distro"`
			Action string `json:"action"`
		}
		if r.Method != http.MethodPost || json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body) != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "pedido inválido"})
			return
		}
		ok, out, err := ponteSetup(r.Context(), body.Target, body.Distro, body.Action)
		resp := map[string]any{"ok": ok, "output": out}
		if err != nil {
			resp["error"] = err.Error()
		}
		writeJSON(w, http.StatusOK, resp)
		return
	}
	// rotas dos agentes (servidor MCP)
	if !settings.ponte().Enabled {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "A ponte de agentes está desligada (Configurações > Ponte de agentes)."})
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "use POST", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		Side      string `json:"side"`
		Cwd       string `json:"cwd"`
		PID       int    `json:"pid"`
		To        string `json:"to"`
		Text      string `json:"text"`
		TimeoutMS int    `json:"timeout_ms"`
		Upto      int64  `json:"upto"`
		AutoName  bool   `json:"auto_name"` // o nome veio da pasta, não de uma escolha
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, ponteMaxText*4+64<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido ou grande demais"})
		return
	}
	switch path {
	case "/register":
		name, side := req.Name, normSide(req.Side)
		// Nome que o usuário conhece (o da sessão do Claude): quem não o achou
		// sozinho (servidor antigo, ou sem o id da sessão) recebe pelo claude.exe
		// que o abriu. Nome escolhido de propósito (--nome) não é trocado.
		if side == "windows" && req.PID > 0 && (req.AutoName || ponteDefaultish(name, side)) {
			if n := claudeSessionName(claudeSessionDirs("windows", ""), "", windowsParentPID(req.PID)); n != "" {
				name = n
			}
		}
		writeJSON(w, http.StatusOK, ponte.register(req.ID, name, side, req.Cwd, req.PID))
	case "/agents":
		writeJSON(w, http.StatusOK, map[string]any{"agents": ponte.list()})
	case "/send":
		m, err := ponte.send(req.ID, req.To, req.Text)
		if err != nil {
			code := http.StatusBadRequest
			if errors.Is(err, errPonteUnknown) {
				code = http.StatusGone
			}
			writeJSON(w, code, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, m)
	case "/wait":
		d := time.Duration(req.TimeoutMS) * time.Millisecond
		if d <= 0 || d > ponteMaxWait {
			d = ponteMaxWait
		}
		msgs, err := ponte.wait(r.Context(), req.ID, d)
		if err != nil {
			writeJSON(w, http.StatusGone, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"messages": msgs})
	case "/ack":
		ponte.ack(req.ID, req.Upto)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case "/notify":
		d := time.Duration(req.TimeoutMS) * time.Millisecond
		if d < 0 {
			d = 0
		}
		if d > ponteMaxWait {
			d = ponteMaxWait
		}
		reg, n := ponte.notifyWait(r.Context(), req.ID, d)
		writeJSON(w, http.StatusOK, map[string]any{"registered": reg, "unread": n})
	case "/bye":
		ponte.bye(req.ID)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		http.NotFound(w, r)
	}
}
