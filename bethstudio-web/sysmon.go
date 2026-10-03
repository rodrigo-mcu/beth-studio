package main

// sysmon.go — "Gerenciador de tarefas": GET /api/sysmon devolve um retrato
// (no maximo um por segundo, em cache) do sistema, da GPU, do disco C:, dos
// processos do Beth Studio, do consumo de cada terminal e do WSL.
//
// Somente leitura em relacao aos processos do usuario: nada e' encerrado,
// suspenso ou sinalizado. A coleta nativa fica em sysmon_windows.go; aqui
// ficam os tipos, a logica pura (arvore de processos, associacao
// processo -> terminal, parsers) e o laco de amostragem.

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf16"
)

// PaneLite: o minimo de um terminal da lista da ponte.
type PaneLite struct {
	ID        int    `json:"pane_id"`
	Title     string `json:"title"`
	CWD       string `json:"cwd"`
	Kind      string `json:"kind"`
	KindLabel string `json:"kind_label"`
}

// ---------------------------------------------------------------- JSON --

type SysmonSnapshot struct {
	At         time.Time    `json:"at"`
	SampleMs   float64      `json:"sample_ms"`
	System     SysStat      `json:"system"`
	CPUHistory []float64    `json:"cpu_history"` // ultimos 60 s, mais antigo primeiro
	GPU        GPUStat      `json:"gpu"`
	Disk       DiskStat     `json:"disk"`
	BethStudio   []BethProc   `json:"bethstudio"`
	Terminals  []TermStat   `json:"terminals"`
	Match      MatchSummary `json:"match"`
	WSL        WSLStat      `json:"wsl"`
}

type SysStat struct {
	RAMTotal    uint64    `json:"ram_total"`
	RAMAvail    uint64    `json:"ram_available"`
	RAMUsed     uint64    `json:"ram_used"`
	RAMLoad     uint32    `json:"ram_load"`
	CommitUsed  uint64    `json:"commit_used"`
	CommitLimit uint64    `json:"commit_limit"`
	CPU         float64   `json:"cpu"`
	Cores       []float64 `json:"cores"`
	UptimeSec   int64     `json:"uptime_sec"`
	Procs       int       `json:"processes"`
}

type GPUAdapter struct {
	LUID          string  `json:"luid"`
	Name          string  `json:"name"`
	Util          float64 `json:"util"`
	TopEngine     string  `json:"top_engine"`
	DedicatedUsed uint64  `json:"dedicated_used"`
	SharedUsed    uint64  `json:"shared_used"`
}

type NvidiaGPU struct {
	Name     string  `json:"name"`
	TempC    float64 `json:"temp_c"`
	MemTotal uint64  `json:"mem_total"`
	MemUsed  uint64  `json:"mem_used"`
	Util     float64 `json:"util"`
}

type GPUStat struct {
	Available bool         `json:"available"`
	Note      string       `json:"note,omitempty"`
	Adapters  []GPUAdapter `json:"adapters"`
	Nvidia    []NvidiaGPU  `json:"nvidia,omitempty"`
}

type DiskStat struct {
	Drive     string  `json:"drive"`
	Total     uint64  `json:"total"`
	Free      uint64  `json:"free"`
	ReadBps   float64 `json:"read_bps"`
	WriteBps  float64 `json:"write_bps"`
	ActivePct float64 `json:"active_pct"`
	Activity  bool    `json:"activity_available"`
}

// ProcStat: um processo (ou a soma de varios, com Count > 1).
type ProcStat struct {
	Name      string  `json:"name"`
	PID       uint32  `json:"pid"`
	WS        uint64  `json:"ws"`         // working set
	PrivateWS uint64  `json:"private_ws"` // "Memoria" do Gerenciador de Tarefas
	Private   uint64  `json:"private"`    // bytes privados (commit)
	CPU       float64 `json:"cpu"`        // % da maquina inteira
	GPU       float64 `json:"gpu,omitempty"`
	Count     int     `json:"count,omitempty"`
}

type BethProc struct {
	Role  string `json:"role"` // host | consoles | gui | web | bridge | webview | cli | other-host
	Label string `json:"label"`
	ProcStat
}

type TermStat struct {
	PaneID       *int       `json:"pane_id"`
	Title        string     `json:"title"`
	Kind         string     `json:"kind"`
	KindLabel    string     `json:"kind_label"`
	Match        string     `json:"match"` // exato | aproximado | ordem | nao_associado | sem_processo
	MatchLabel   string     `json:"match_label"`
	ConsoleTitle string     `json:"console_title,omitempty"`
	ShellPID     uint32     `json:"shell_pid,omitempty"`
	ShellName    string     `json:"shell_name,omitempty"`
	WS           uint64     `json:"ws"`
	PrivateWS    uint64     `json:"private_ws"`
	Private      uint64     `json:"private"`
	CPU          float64    `json:"cpu"`
	Procs        int        `json:"procs"`
	Top          []ProcStat `json:"top"`
	Note         string     `json:"note,omitempty"`
}

type MatchSummary struct {
	Panes           int    `json:"panes"`
	Shells          int    `json:"shells"`
	Exact           int    `json:"exact"`
	Approx          int    `json:"approx"`
	Order           int    `json:"order"`
	Unmatched       int    `json:"unmatched"`
	TitlesAvailable bool   `json:"titles_available"`
	HostPID         uint32 `json:"host_pid"`
	Note            string `json:"note,omitempty"`
}

type LinuxMem struct {
	Total     uint64 `json:"total"`
	Used      uint64 `json:"used"`
	Free      uint64 `json:"free"`
	Available uint64 `json:"available"`
	BuffCache uint64 `json:"buff_cache"`
	SwapTotal uint64 `json:"swap_total"`
	SwapUsed  uint64 `json:"swap_used"`
	// Swaps: cada area de /proc/swaps (zram e arquivo em disco separados).
	Swaps []LinuxSwap `json:"swaps,omitempty"`
}

// LinuxSwap: uma linha de /proc/swaps. Para zram, ZramPhys e' a RAM que o
// pool comprimido ocupa de fato (mm_stat mem_used_total) e ZramLimit o teto
// (mm_stat mem_limit, 0 = sem teto).
type LinuxSwap struct {
	Name      string `json:"name"`
	Kind      string `json:"kind"` // "zram", "file" ou "partition"
	Size      uint64 `json:"size"`
	Used      uint64 `json:"used"`
	Prio      int    `json:"prio"`
	ZramPhys  uint64 `json:"zram_phys,omitempty"`
	ZramLimit uint64 `json:"zram_limit,omitempty"`
}

// LinuxDisk: `df` da raiz da distro (o disco virtual do WSL2).
type LinuxDisk struct {
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
	Avail uint64 `json:"avail"`
	Mount string `json:"mount"`
}

type LinuxProc struct {
	PID     int     `json:"pid"`
	RSS     uint64  `json:"rss"`
	PCPU    float64 `json:"pcpu"` // media desde o inicio do processo (ps)
	Elapsed string  `json:"elapsed"`
	Comm    string  `json:"comm"`
}

type WSLDistro struct {
	Name      string      `json:"name"`
	State     string      `json:"state"`
	Version   int         `json:"version"`
	Default   bool        `json:"default"`
	Running   bool        `json:"running"`
	Mem       *LinuxMem   `json:"mem,omitempty"`
	Disk      *LinuxDisk  `json:"disk,omitempty"`
	Load      []float64   `json:"load,omitempty"`
	Top       []LinuxProc `json:"top,omitempty"`
	Error     string      `json:"error,omitempty"`
	SampledAt *time.Time  `json:"sampled_at,omitempty"`
}

// WSLPoint: um segundo do grafico do WSL2 (0..100). RAMOK/DiskOK falsos
// enquanto o `free`/`df` da distro ainda nao chegou.
type WSLPoint struct {
	RAM    float64 `json:"ram"`
	RAMOK  bool    `json:"ram_ok"`
	CPU    float64 `json:"cpu"`
	Disk   float64 `json:"disk"`
	DiskOK bool    `json:"disk_ok"`
}

// WSLUsage: RAM vista de dentro do WSL2 (usado e reservado na VM), CPU da
// VM no Windows e disco da distro padrao. History guarda os ultimos 60 s.
type WSLUsage struct {
	RAMBytes    uint64  `json:"ram_bytes"` // working set da VM no Windows
	RAMUsed     uint64  `json:"ram_used"`  // usado dentro do WSL2 (free)
	RAMReserved uint64  `json:"ram_reserved"`
	RAMPct      float64 `json:"ram_pct"` // usado / reservado
	RAMKnown    bool    `json:"ram_known"`
	CPU         float64 `json:"cpu"`
	DiskUsed    uint64  `json:"disk_used"`
	DiskTotal   uint64  `json:"disk_total"`
	DiskPct     float64 `json:"disk_pct"`
	DiskDistro  string  `json:"disk_distro,omitempty"`
	DiskKnown   bool    `json:"disk_known"`
	// Swaps da distro usada para a RAM: zram (RAM comprimida) e disco.
	Swaps   []LinuxSwap `json:"swaps,omitempty"`
	History []WSLPoint  `json:"history"`
}

type WSLStat struct {
	VM        *ProcStat   `json:"vm"`
	VMRunning bool        `json:"vm_running"`
	Distros   []WSLDistro `json:"distros"`
	Note      string      `json:"note,omitempty"`
	Usage     WSLUsage    `json:"usage"`
}

// ------------------------------------------------- arvore de processos --

// procInfo: um processo do retrato nativo.
type procInfo struct {
	PID, PPID uint32
	Name      string
	Created   int64 // FILETIME (100 ns)
	CPUTime   int64 // user + kernel (100 ns)
	WS        uint64
	PrivateWS uint64
	Private   uint64
	CPU       float64 // preenchido depois (delta)
	GPU       float64
}

type procKey struct {
	PID     uint32
	Created int64
}

func (p *procInfo) key() procKey { return procKey{p.PID, p.Created} }

func (p *procInfo) stat() ProcStat {
	return ProcStat{Name: p.Name, PID: p.PID, WS: p.WS, PrivateWS: p.PrivateWS, Private: p.Private, CPU: round1(p.CPU), GPU: round1(p.GPU)}
}

type procTree struct {
	byPID    map[uint32]*procInfo
	children map[uint32][]*procInfo
}

// buildTree: um pai so' conta se foi criado antes do filho (PIDs reciclados).
func buildTree(ps []*procInfo) *procTree {
	t := &procTree{byPID: map[uint32]*procInfo{}, children: map[uint32][]*procInfo{}}
	for _, p := range ps {
		t.byPID[p.PID] = p
	}
	for _, p := range ps {
		if p.PPID == p.PID || p.PID == 0 {
			continue
		}
		if par, ok := t.byPID[p.PPID]; ok && par.Created <= p.Created {
			t.children[p.PPID] = append(t.children[p.PPID], p)
		}
	}
	for _, c := range t.children {
		sort.Slice(c, func(i, j int) bool { return c[i].Created < c[j].Created })
	}
	return t
}

// subtree: o processo e todos os descendentes.
func (t *procTree) subtree(root *procInfo) []*procInfo {
	out := []*procInfo{root}
	seen := map[uint32]bool{root.PID: true}
	for i := 0; i < len(out); i++ {
		for _, c := range t.children[out[i].PID] {
			if !seen[c.PID] {
				seen[c.PID] = true
				out = append(out, c)
			}
		}
	}
	return out
}

func sumProcs(ps []*procInfo) (s ProcStat) {
	for _, p := range ps {
		s.WS += p.WS
		s.PrivateWS += p.PrivateWS
		s.Private += p.Private
		s.CPU += p.CPU
		s.GPU += p.GPU
	}
	s.CPU = round1(s.CPU)
	s.GPU = round1(s.GPU)
	s.Count = len(ps)
	return
}

func topProcs(ps []*procInfo, n int) []ProcStat {
	cp := append([]*procInfo(nil), ps...)
	sort.SliceStable(cp, func(i, j int) bool {
		if cp[i].PrivateWS != cp[j].PrivateWS {
			return cp[i].PrivateWS > cp[j].PrivateWS
		}
		return cp[i].CPU > cp[j].CPU
	})
	if len(cp) > n {
		cp = cp[:n]
	}
	out := make([]ProcStat, len(cp))
	for i, p := range cp {
		out[i] = p.stat()
	}
	return out
}

func isConsoleHost(name string) bool {
	n := strings.ToLower(name)
	return n == "openconsole.exe" || n == "conhost.exe"
}

// ------------------------------------------- associacao shell -> pane --

var titleGlyphs = map[rune]bool{'✳': true, '✻': true, '✶': true, '✢': true, '·': true, '◐': true, '◑': true, '◒': true, '◓': true, '⏺': true, '●': true, '○': true}

// normalizeTitle: sem glifos de status (Claude Code e spinners braille),
// espacos colapsados, minusculas, sem "Administrador: ".
func normalizeTitle(s string) string {
	s = strings.TrimSpace(s)
	for _, pre := range []string{"Administrator: ", "Administrador: "} {
		s = strings.TrimPrefix(s, pre)
	}
	var b strings.Builder
	space := false
	for _, r := range s {
		if titleGlyphs[r] || (r >= 0x2800 && r <= 0x28FF) || r == 0xFE0F || unicode.IsControl(r) {
			r = ' '
		}
		if unicode.IsSpace(r) {
			space = true
			continue
		}
		if space && b.Len() > 0 {
			b.WriteByte(' ')
		}
		space = false
		b.WriteRune(unicode.ToLower(r))
	}
	out := b.String()
	// "claude.exe" (titulo do pane pelo nome do processo) = "claude" (console);
	// um caminho de exe vira so' o nome.
	if !strings.Contains(out, " ") && strings.HasSuffix(out, ".exe") {
		if i := strings.LastIndexAny(out, `\/`); i >= 0 {
			out = out[i+1:]
		}
		out = strings.TrimSuffix(out, ".exe")
	}
	return out
}

// shellCand: um filho direto do host que nao e' OpenConsole (o shell de um pane).
type shellCand struct {
	Key     procKey
	Created int64
	Title   string // titulo do console ("" = nao lido)
}

type paneMatch struct {
	PaneID int
	Conf   string // exato | aproximado | ordem
}

// matchShells associa shells a panes:
//  1. titulo exato e unico dos dois lados -> "exato";
//  2. titulo normalizado e unico -> "aproximado";
//  3. grupos de mesmo titulo normalizado com o mesmo tamanho: pareados por
//     ordem (pane id crescente = shell criado antes) -> "aproximado";
//  4. sobras: se sobrarem tantos shells quanto panes, pareados por ordem
//     de criacao -> "ordem" (estimado) (o host cria o shell ao criar o pane, e os ids
//     crescem). Senao ficam sem associacao.
func matchShells(shells []shellCand, panes []PaneLite) map[procKey]paneMatch {
	out := map[procKey]paneMatch{}
	usedPane := map[int]bool{}
	done := func(k procKey) bool { _, ok := out[k]; return ok }

	pass := func(norm bool, conf string) {
		key := func(s string) string {
			if norm {
				return normalizeTitle(s)
			}
			return s
		}
		sh := map[string][]shellCand{}
		for _, s := range shells {
			if !done(s.Key) && s.Title != "" {
				sh[key(s.Title)] = append(sh[key(s.Title)], s)
			}
		}
		pn := map[string][]PaneLite{}
		for _, p := range panes {
			if !usedPane[p.ID] && p.Title != "" {
				pn[key(p.Title)] = append(pn[key(p.Title)], p)
			}
		}
		for t, ss := range sh {
			ps := pn[t]
			if t == "" || len(ss) != 1 || len(ps) != 1 {
				continue
			}
			out[ss[0].Key] = paneMatch{ps[0].ID, conf}
			usedPane[ps[0].ID] = true
		}
	}
	pass(false, "exato")
	pass(true, "aproximado")

	// 3: grupos repetidos (varios "✳ Claude Code") pareados por ordem.
	{
		sh := map[string][]shellCand{}
		for _, s := range shells {
			if !done(s.Key) && s.Title != "" {
				k := normalizeTitle(s.Title)
				sh[k] = append(sh[k], s)
			}
		}
		pn := map[string][]PaneLite{}
		for _, p := range panes {
			if !usedPane[p.ID] {
				k := normalizeTitle(p.Title)
				pn[k] = append(pn[k], p)
			}
		}
		for t, ss := range sh {
			ps := pn[t]
			if t == "" || len(ss) < 2 || len(ss) != len(ps) {
				continue
			}
			zipByOrder(ss, ps, "aproximado", out, usedPane)
		}
	}

	// 4: sobras por ordem de criacao.
	var ss []shellCand
	for _, s := range shells {
		if !done(s.Key) {
			ss = append(ss, s)
		}
	}
	var ps []PaneLite
	for _, p := range panes {
		if !usedPane[p.ID] {
			ps = append(ps, p)
		}
	}
	if len(ss) > 0 && len(ss) == len(ps) {
		zipByOrder(ss, ps, "ordem", out, usedPane)
	}
	return out
}

func zipByOrder(ss []shellCand, ps []PaneLite, conf string, out map[procKey]paneMatch, used map[int]bool) {
	ss = append([]shellCand(nil), ss...)
	ps = append([]PaneLite(nil), ps...)
	sort.Slice(ss, func(i, j int) bool { return ss[i].Created < ss[j].Created })
	sort.Slice(ps, func(i, j int) bool { return ps[i].ID < ps[j].ID })
	for i := range ss {
		out[ss[i].Key] = paneMatch{ps[i].ID, conf}
		used[ps[i].ID] = true
	}
}

func matchLabel(conf string) string {
	switch conf {
	case "exato":
		return "título exato"
	case "aproximado":
		return "título aproximado"
	case "ordem":
		return "ordem de criação (estimado)"
	case "sem_processo":
		return "processo não encontrado"
	}
	return "não associado"
}

// buildTerminals monta a tabela "Terminais" a partir da arvore do host.
func buildTerminals(t *procTree, host *procInfo, panes []PaneLite, titles map[procKey]string, stable map[procKey]paneMatch) ([]TermStat, MatchSummary, map[procKey]paneMatch) {
	sum := MatchSummary{Panes: len(panes)}
	if host == nil {
		sum.Note = "bethstudio-host.exe não está rodando"
		var ts []TermStat
		for _, p := range panes {
			id := p.ID
			ts = append(ts, TermStat{PaneID: &id, Title: p.Title, Kind: p.Kind, KindLabel: p.KindLabel, Match: "sem_processo", MatchLabel: matchLabel("sem_processo")})
		}
		return ts, sum, stable
	}
	sum.HostPID = host.PID
	byID := map[int]PaneLite{}
	for _, p := range panes {
		byID[p.ID] = p
	}
	var shells []*procInfo
	for _, c := range t.children[host.PID] {
		if !isConsoleHost(c.Name) {
			shells = append(shells, c)
		}
	}
	sum.Shells = len(shells)

	// Associacoes estaveis (titulo unico) valem enquanto shell e pane existirem.
	result := map[procKey]paneMatch{}
	newStable := map[procKey]paneMatch{}
	usedPane := map[int]bool{}
	for _, s := range shells {
		if m, ok := stable[s.key()]; ok {
			if _, alive := byID[m.PaneID]; alive && !usedPane[m.PaneID] {
				result[s.key()] = m
				newStable[s.key()] = m
				usedPane[m.PaneID] = true
			}
		}
	}
	var cands []shellCand
	for _, s := range shells {
		if _, ok := result[s.key()]; !ok {
			cands = append(cands, shellCand{Key: s.key(), Created: s.Created, Title: titles[s.key()]})
		}
	}
	var rest []PaneLite
	for _, p := range panes {
		if !usedPane[p.ID] {
			rest = append(rest, p)
		}
	}
	for k, m := range matchShells(cands, rest) {
		result[k] = m
		if m.Conf == "exato" || (m.Conf == "aproximado" && uniqueNormTitle(byID[m.PaneID].Title, panes)) {
			newStable[k] = m
		}
	}

	var out []TermStat
	matchedPane := map[int]bool{}
	for _, s := range shells {
		sub := t.subtree(s)
		agg := sumProcs(sub)
		ts := TermStat{
			ConsoleTitle: titles[s.key()], ShellPID: s.PID, ShellName: s.Name,
			WS: agg.WS, PrivateWS: agg.PrivateWS, Private: agg.Private, CPU: agg.CPU, Procs: len(sub), Top: topProcs(sub, 5),
		}
		if m, ok := result[s.key()]; ok {
			p := byID[m.PaneID]
			id := p.ID
			ts.PaneID, ts.Title, ts.Kind, ts.KindLabel = &id, p.Title, p.Kind, p.KindLabel
			ts.Match = m.Conf
			matchedPane[id] = true
			switch m.Conf {
			case "exato":
				sum.Exact++
			case "ordem":
				sum.Order++
			default:
				sum.Approx++
			}
		} else {
			ts.Match = "nao_associado"
			ts.Title = "Não associado: " + smFirstNonEmpty(ts.ConsoleTitle, s.Name)
			ts.Kind = kindFromExe(s.Name)
			sum.Unmatched++
		}
		ts.MatchLabel = matchLabel(ts.Match)
		if ts.Kind == "wsl" {
			ts.Note = "dentro do WSL (ver total da distro)"
		}
		out = append(out, ts)
	}
	for _, p := range panes {
		if !matchedPane[p.ID] {
			id := p.ID
			out = append(out, TermStat{PaneID: &id, Title: p.Title, Kind: p.Kind, KindLabel: p.KindLabel, Match: "sem_processo", MatchLabel: matchLabel("sem_processo")})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].PrivateWS > out[j].PrivateWS })
	return out, sum, newStable
}

func uniqueNormTitle(title string, panes []PaneLite) bool {
	n := normalizeTitle(title)
	c := 0
	for _, p := range panes {
		if normalizeTitle(p.Title) == n {
			c++
		}
	}
	return c == 1
}

func kindFromExe(name string) string {
	switch strings.ToLower(name) {
	case "wsl.exe", "wslhost.exe":
		return "wsl"
	case "powershell.exe":
		return "powershell"
	case "pwsh.exe":
		return "pwsh"
	case "cmd.exe":
		return "cmd"
	}
	return "other"
}

func smFirstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

// buildBethStudio: linhas da secao "Beth Studio".
func buildBethStudio(t *procTree, all []*procInfo, host *procInfo) []BethProc {
	var out []BethProc
	for _, p := range all {
		switch strings.ToLower(p.Name) {
		case "bethstudio-host.exe":
			role, label := "host", "Host (bethstudio-host)"
			if host != nil && p.PID != host.PID {
				role, label = "other-host", "Outro host (bethstudio-host)"
			}
			out = append(out, BethProc{Role: role, Label: label, ProcStat: p.stat()})
			var cons []*procInfo
			for _, c := range t.children[p.PID] {
				if isConsoleHost(c.Name) {
					cons = append(cons, c)
				}
			}
			if len(cons) > 0 {
				s := sumProcs(cons)
				s.Name, s.PID = "OpenConsole.exe", p.PID
				out = append(out, BethProc{Role: "consoles", Label: "Consoles dos terminais (OpenConsole × " + strconv.Itoa(len(cons)) + ")", ProcStat: s})
			}
		case "bethterm-gui.exe":
			out = append(out, BethProc{Role: "gui", Label: "Janela nativa antiga (bethterm-gui)", ProcStat: p.stat()})
		case "bethstudio-web.exe":
			out = append(out, BethProc{Role: "web", Label: "Web (bethstudio-web)", ProcStat: p.stat()})
			sub := t.subtree(p)[1:]
			var bridges, views []*procInfo
			for _, c := range sub {
				n := strings.ToLower(c.Name)
				if n == "bethstudio.exe" {
					bridges = append(bridges, c)
				} else {
					views = append(views, c)
				}
			}
			for _, b := range bridges {
				out = append(out, BethProc{Role: "bridge", Label: "Ponte (bethstudio cli bridge)", ProcStat: b.stat()})
			}
			if len(views) > 0 {
				s := sumProcs(views)
				s.Name, s.PID = "msedgewebview2.exe", p.PID
				out = append(out, BethProc{Role: "webview", Label: "WebView2 da janela web (" + strconv.Itoa(len(views)) + " processos)", ProcStat: s})
			}
		}
	}
	return out
}

// ---------------------------------------------------------------- WSL --

// decodeMaybeUTF16: `wsl.exe -l -v` escreve UTF-16LE (a menos que WSL_UTF8=1).
func decodeMaybeUTF16(b []byte) string {
	if len(b) >= 2 && b[0] == 0xFF && b[1] == 0xFE {
		b = b[2:]
	}
	zeros := 0
	for i := 1; i < len(b); i += 2 {
		if b[i] == 0 {
			zeros++
		}
	}
	if len(b) >= 2 && zeros*2 >= len(b)/2 {
		u := make([]uint16, len(b)/2)
		for i := range u {
			u[i] = uint16(b[2*i]) | uint16(b[2*i+1])<<8
		}
		return string(utf16.Decode(u))
	}
	return string(b)
}

// parseWSLList: saida de `wsl.exe -l -v` (ingles ou traduzida). A primeira
// linha e' o cabecalho; cada linha: [*] NOME ESTADO VERSAO.
func parseWSLList(b []byte) []WSLDistro {
	text := strings.ReplaceAll(decodeMaybeUTF16(b), "\r", "")
	var out []WSLDistro
	lines := strings.Split(text, "\n")
	for i, ln := range lines {
		ln = strings.TrimRight(strings.ReplaceAll(ln, "\x00", ""), " ")
		if i == 0 || strings.TrimSpace(ln) == "" {
			continue
		}
		d := WSLDistro{}
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(t, "*") {
			d.Default = true
			t = strings.TrimSpace(t[1:])
		}
		f := strings.Fields(t)
		if len(f) < 3 {
			continue
		}
		v, err := strconv.Atoi(f[len(f)-1])
		if err != nil {
			continue
		}
		d.Version = v
		d.Name = f[0]
		d.State = strings.Join(f[1:len(f)-1], " ")
		st := strings.ToLower(d.State)
		d.Running = st == "running" || strings.Contains(st, "execu") // "Em execução"
		out = append(out, d)
	}
	return out
}

// parseDistroProbe: saida de `free -b; df -B1 -P /; cat /proc/loadavg;
// cat /proc/swaps; ZRAM <dev> <mm_stat>...; ps -eo ...`.
func parseDistroProbe(s string) (mem *LinuxMem, disk *LinuxDisk, load []float64, procs []LinuxProc) {
	s = strings.ReplaceAll(s, "\r", "")
	inPS := false
	dfBlock := uint64(1)
	var swaps []LinuxSwap
	zram := map[string][2]uint64{} // zram0 -> {mem_used_total, mem_limit}
	for _, ln := range strings.Split(s, "\n") {
		f := strings.Fields(ln)
		if len(f) == 0 {
			continue
		}
		if !inPS && f[0] == "ZRAM" && len(f) >= 6 {
			zram[f[1]] = [2]uint64{pu(f[4]), pu(f[5])}
			continue
		}
		if !inPS && len(f) == 5 && strings.HasPrefix(f[0], "/") && (f[1] == "partition" || f[1] == "file") {
			size, e1 := strconv.ParseUint(f[2], 10, 64)
			used, e2 := strconv.ParseUint(f[3], 10, 64)
			prio, e3 := strconv.Atoi(f[4])
			if e1 == nil && e2 == nil && e3 == nil {
				kind := f[1]
				if strings.HasPrefix(f[0], "/dev/zram") {
					kind = "zram"
				}
				swaps = append(swaps, LinuxSwap{Name: f[0], Kind: kind, Size: size * 1024, Used: used * 1024, Prio: prio})
				continue
			}
		}
		switch {
		case !inPS && strings.Contains(ln, "-blocks"):
			switch {
			case strings.Contains(ln, "1B-blocks"):
				dfBlock = 1
			case strings.Contains(ln, "1K-blocks"), strings.Contains(ln, "1024-blocks"):
				dfBlock = 1024
			case strings.Contains(ln, "512-blocks"):
				dfBlock = 512
			}
		case !inPS && len(f) >= 6 && strings.HasPrefix(f[len(f)-1], "/"):
			total, e1 := strconv.ParseUint(f[1], 10, 64)
			used, e2 := strconv.ParseUint(f[2], 10, 64)
			avail, e3 := strconv.ParseUint(f[3], 10, 64)
			if e1 != nil || e2 != nil || e3 != nil {
				break
			}
			mount := f[len(f)-1]
			if disk == nil || mount == "/" {
				disk = &LinuxDisk{Total: total * dfBlock, Used: used * dfBlock, Avail: avail * dfBlock, Mount: mount}
			}
		case f[0] == "Mem:" && len(f) >= 4:
			if mem == nil {
				mem = &LinuxMem{}
			}
			mem.Total, mem.Used, mem.Free = pu(f[1]), pu(f[2]), pu(f[3])
			if len(f) >= 7 {
				mem.BuffCache, mem.Available = pu(f[5]), pu(f[6])
			}
		case f[0] == "Swap:" && len(f) >= 3:
			if mem == nil {
				mem = &LinuxMem{}
			}
			mem.SwapTotal, mem.SwapUsed = pu(f[1]), pu(f[2])
		case f[0] == "PID":
			inPS = true
		case inPS && len(f) >= 5:
			pid, err := strconv.Atoi(f[0])
			if err != nil {
				continue
			}
			rss := pu(f[1]) * 1024
			pc, _ := strconv.ParseFloat(strings.ReplaceAll(f[2], ",", "."), 64)
			procs = append(procs, LinuxProc{PID: pid, RSS: rss, PCPU: pc, Elapsed: f[3], Comm: strings.Join(f[4:], " ")})
		case !inPS && len(f) == 5 && strings.Contains(f[3], "/") && load == nil:
			for _, x := range f[:3] {
				v, err := strconv.ParseFloat(x, 64)
				if err != nil {
					load = nil
					break
				}
				load = append(load, v)
			}
		}
	}
	for i := range swaps {
		if z, ok := zram[strings.TrimPrefix(swaps[i].Name, "/dev/")]; ok {
			swaps[i].ZramPhys, swaps[i].ZramLimit = z[0], z[1]
		}
	}
	if mem != nil {
		mem.Swaps = swaps
	}
	return
}

// wslHelperDistro: distros de ferramenta (Docker, Rancher) nao sao o disco
// do dia a dia quando existe outra em execucao.
func wslHelperDistro(name string) bool {
	n := strings.ToLower(name)
	return n == "docker-desktop" || n == "docker-desktop-data" || strings.HasPrefix(n, "rancher-desktop")
}

// pickWSLDisk: disco da distro padrao em execucao; senao a primeira distro
// de uso geral; por ultimo uma distro auxiliar.
func pickWSLDisk(distros []WSLDistro) (used, total uint64, name string, ok bool) {
	var first, real *WSLDistro
	for i := range distros {
		d := &distros[i]
		if !d.Running || d.Disk == nil || d.Disk.Total == 0 {
			continue
		}
		if d.Default {
			return d.Disk.Used, d.Disk.Total, d.Name, true
		}
		if first == nil {
			first = d
		}
		if real == nil && !wslHelperDistro(d.Name) {
			real = d
		}
	}
	if real != nil {
		return real.Disk.Used, real.Disk.Total, real.Name, true
	}
	if first != nil {
		return first.Disk.Used, first.Disk.Total, first.Name, true
	}
	return 0, 0, "", false
}

// pickWSLMem: memoria da VM, lida por dentro da distro (todas as WSL2
// compartilham a mesma). Prefere a distro padrao.
func pickWSLMem(distros []WSLDistro) (*LinuxMem, bool) {
	var first, real *WSLDistro
	for i := range distros {
		d := &distros[i]
		if !d.Running || d.Mem == nil || d.Mem.Total == 0 {
			continue
		}
		if d.Default {
			return d.Mem, true
		}
		if first == nil {
			first = d
		}
		if real == nil && !wslHelperDistro(d.Name) {
			real = d
		}
	}
	if real != nil {
		return real.Mem, true
	}
	if first != nil {
		return first.Mem, true
	}
	return nil, false
}

// wslUsage: retrato atual para o grafico. RAM e' o usado dentro do WSL2
// sobre o reservado da VM; disco% e' o quanto a raiz da distro esta' cheia.
func wslUsage(vm *ProcStat, distros []WSLDistro) WSLUsage {
	u := WSLUsage{}
	if vm != nil {
		u.RAMBytes = vm.WS
		u.CPU = round1(vm.CPU)
	}
	if m, ok := pickWSLMem(distros); ok {
		u.RAMUsed, u.RAMReserved, u.RAMKnown, u.Swaps = m.Used, m.Total, true, m.Swaps
		if m.Total > 0 {
			u.RAMPct = round1(float64(m.Used) / float64(m.Total) * 100)
		}
	}
	if used, total, name, ok := pickWSLDisk(distros); ok {
		u.DiskUsed, u.DiskTotal, u.DiskDistro, u.DiskKnown = used, total, name, true
		if total > 0 {
			u.DiskPct = round1(float64(used) / float64(total) * 100)
		}
	}
	return u
}

// appendWSLHistory: guarda no maximo `max` segundos. Devolve uma fatia nova
// quando descarta o inicio, para nao reescrever um retrato ja' copiado.
func appendWSLHistory(hist []WSLPoint, p WSLPoint, max int) []WSLPoint {
	if p.RAMOK {
		p.RAM = round1(p.RAM)
	} else {
		p.RAM = 0
	}
	p.CPU = round1(p.CPU)
	if p.DiskOK {
		p.Disk = round1(p.Disk)
	} else {
		p.Disk = 0
	}
	hist = append(hist, p)
	if max > 0 && len(hist) > max {
		hist = append([]WSLPoint(nil), hist[len(hist)-max:]...)
	}
	return hist
}

func pu(s string) uint64 {
	v, _ := strconv.ParseUint(s, 10, 64)
	return v
}

// parseNvidiaSmi: --query-gpu=name,temperature.gpu,memory.total,memory.used,utilization.gpu
// --format=csv,noheader,nounits (memoria em MiB).
func parseNvidiaSmi(s string) []NvidiaGPU {
	var out []NvidiaGPU
	for _, ln := range strings.Split(strings.ReplaceAll(s, "\r", ""), "\n") {
		f := strings.Split(ln, ",")
		if len(f) < 5 {
			continue
		}
		for i := range f {
			f[i] = strings.TrimSpace(f[i])
		}
		num := func(x string) float64 { v, _ := strconv.ParseFloat(x, 64); return v }
		out = append(out, NvidiaGPU{
			Name: f[0], TempC: num(f[1]),
			MemTotal: uint64(num(f[2])) << 20, MemUsed: uint64(num(f[3])) << 20, Util: num(f[4]),
		})
	}
	return out
}

// parseGPUEngineInstance: "pid_1234_luid_0x00000000_0x0000D1B6_phys_0_eng_0_engtype_3D".
func parseGPUEngineInstance(s string) (pid uint32, luid, engtype string, ok bool) {
	if !strings.HasPrefix(s, "pid_") {
		return
	}
	rest := s[4:]
	i := strings.Index(rest, "_luid_")
	if i < 0 {
		return
	}
	p, err := strconv.ParseUint(rest[:i], 10, 32)
	if err != nil {
		return
	}
	rest = rest[i+6:]
	j := strings.Index(rest, "_phys_")
	if j < 0 {
		return
	}
	luid = rest[:j]
	if k := strings.Index(rest, "_engtype_"); k >= 0 {
		engtype = rest[k+9:]
	}
	return uint32(p), luid, engtype, true
}

// parseGPUMemInstance: "luid_0x00000000_0x0000D1B6_phys_0".
func parseGPUMemInstance(s string) (luid string, ok bool) {
	if !strings.HasPrefix(s, "luid_") {
		return
	}
	rest := s[5:]
	j := strings.Index(rest, "_phys_")
	if j < 0 {
		return rest, true
	}
	return rest[:j], true
}

// gpuEngineSample: um valor de `\GPU Engine(*)\Utilization Percentage`.
type gpuEngineSample struct {
	Instance string
	Value    float64
}

// aggregateGPU: por adaptador, a soma por tipo de motor; a utilizacao do
// adaptador e' o motor mais ocupado (como no Gerenciador de Tarefas). Por
// processo, idem.
func aggregateGPU(eng []gpuEngineSample) (adapters map[string]*GPUAdapter, byPID map[uint32]float64) {
	type k2 struct{ a, b string }
	perAdapter := map[k2]float64{}
	type kp struct {
		pid uint32
		e   string
	}
	perProc := map[kp]float64{}
	adapters = map[string]*GPUAdapter{}
	for _, s := range eng {
		pid, luid, et, ok := parseGPUEngineInstance(s.Instance)
		if !ok {
			continue
		}
		if et == "" {
			et = "?"
		}
		perAdapter[k2{luid, et}] += s.Value
		perProc[kp{pid, luid + "/" + et}] += s.Value
		if adapters[luid] == nil {
			adapters[luid] = &GPUAdapter{LUID: luid}
		}
	}
	for k, v := range perAdapter {
		a := adapters[k.a]
		if v > a.Util {
			a.Util, a.TopEngine = v, k.b
		}
	}
	for _, a := range adapters {
		if a.Util > 100 {
			a.Util = 100
		}
		a.Util = round1(a.Util)
	}
	byPID = map[uint32]float64{}
	for k, v := range perProc {
		if v > byPID[k.pid] {
			byPID[k.pid] = v
		}
	}
	return
}

func round1(v float64) float64 {
	if v < 0 {
		return 0
	}
	return float64(int64(v*10+0.5)) / 10
}

// ------------------------------------------------ servico e amostragem --

// sysmon: um laco de 1 s que so' roda enquanto alguem consultou nos
// ultimos 10 s. O JSON fica em cache (no maximo um retrato por segundo).
type sysmon struct {
	panes func() []PaneLite

	mu       sync.Mutex
	snap     []byte
	lastPoll time.Time
	running  bool
	ready    chan struct{}
}

func newSysmon(panes func() []PaneLite) *sysmon {
	if panes == nil {
		panes = func() []PaneLite { return nil }
	}
	return &sysmon{panes: panes}
}

const sysmonIdleStop = 10 * time.Second

func (m *sysmon) get() []byte {
	m.mu.Lock()
	m.lastPoll = time.Now()
	if !m.running {
		m.running = true
		m.snap = nil
		m.ready = make(chan struct{})
		go m.loop(m.ready)
	}
	snap, ready := m.snap, m.ready
	m.mu.Unlock()
	if snap != nil {
		return snap
	}
	select {
	case <-ready:
	case <-time.After(4 * time.Second):
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.snap
}

func (m *sysmon) loop(ready chan struct{}) {
	s := newSampler()
	defer s.close()
	s.prime(m.panes)
	time.Sleep(500 * time.Millisecond)
	publish := func() {
		b, err := json.Marshal(s.sample(m.panes))
		if err != nil {
			return
		}
		m.mu.Lock()
		m.snap = b
		m.mu.Unlock()
	}
	publish()
	close(ready)
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for range t.C {
		m.mu.Lock()
		idle := time.Since(m.lastPoll) > sysmonIdleStop
		if idle {
			m.running = false
			m.snap = nil
		}
		m.mu.Unlock()
		if idle {
			return
		}
		publish()
	}
}

func (m *sysmon) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		return
	}
	b := m.get()
	if b == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "coleta ainda não disponível"})
		return
	}
	writeRawJSON(w, b)
}

// registerSysmonRoutes: para quem usa um ServeMux (o server.go atual usa um
// switch; ali basta `case "/api/sysmon": s.serveSysmon(w, r)`).
func registerSysmonRoutes(mux *http.ServeMux, auth func(http.Handler) http.Handler, panes func() []PaneLite) {
	var h http.Handler = newSysmon(panes)
	if auth != nil {
		h = auth(h)
	}
	mux.Handle("/api/sysmon", h)
}

// --- integracao com o server/hub existentes (sem editar os arquivos deles) --

var (
	sysmonOnce sync.Once
	sysmonInst *sysmon
)

// serveSysmon: GET /api/sysmon (token, Host e Origin ja' conferidos pelo ServeHTTP).
func (s *server) serveSysmon(w http.ResponseWriter, r *http.Request) {
	sysmonOnce.Do(func() { sysmonInst = newSysmon(s.hub.sysmonPanes) })
	sysmonInst.ServeHTTP(w, r)
}

// sysmonPanes: os terminais da ultima lista da ponte (ja' com kind).
func (h *hub) sysmonPanes() []PaneLite {
	h.mu.Lock()
	list := h.lastList
	h.mu.Unlock()
	return panesFromList(list)
}

func panesFromList(list []byte) []PaneLite {
	if list == nil {
		return nil
	}
	var ev struct {
		Panes []PaneLite `json:"panes"`
	}
	if json.Unmarshal(list, &ev) != nil {
		return nil
	}
	return ev.Panes
}

// --- auxiliar de titulos de console (--console-titles) ------------------

const (
	consoleTitlesFlag = "--console-titles"
	maxTitlePIDs      = 64
)

type consoleTitleLine struct {
	PID   uint32 `json:"pid"`
	Title string `json:"title"`
}

func formatPIDList(pids []uint32) string {
	parts := make([]string, 0, len(pids))
	for _, p := range pids {
		parts = append(parts, strconv.FormatUint(uint64(p), 10))
	}
	return strings.Join(parts, ",")
}

// parsePIDList: so' numeros > 0, sem repetir, no maximo maxTitlePIDs.
func parsePIDList(arg string) []uint32 {
	var out []uint32
	seen := map[uint32]bool{}
	for _, f := range strings.Split(arg, ",") {
		v, err := strconv.ParseUint(strings.TrimSpace(f), 10, 32)
		if err != nil || v == 0 || seen[uint32(v)] {
			continue
		}
		seen[uint32(v)] = true
		out = append(out, uint32(v))
		if len(out) == maxTitlePIDs {
			break
		}
	}
	return out
}

// parseConsoleTitleLines le a saida do auxiliar (uma linha JSON por pid);
// linhas quebradas (auxiliar morto no meio) e pids nao pedidos sao ignorados.
func parseConsoleTitleLines(out string, asked []uint32) map[uint32]string {
	want := map[uint32]bool{}
	for _, p := range asked {
		want[p] = true
	}
	got := map[uint32]string{}
	for _, ln := range strings.Split(out, "\n") {
		var l consoleTitleLine
		if json.Unmarshal([]byte(strings.TrimSpace(ln)), &l) != nil || !want[l.PID] {
			continue
		}
		if len(l.Title) > 2048 {
			l.Title = l.Title[:2048]
		}
		got[l.PID] = l.Title
	}
	return got
}

// parseWSLRunningNames: saida de `wsl -l --running -q` (UTF-16 ou UTF-8),
// um nome por linha. Frases (ex. "Nao ha distribuicoes em execucao") nao
// sao nomes: so' entra linha de uma palavra so'.
func parseWSLRunningNames(b []byte) []string {
	text := strings.ReplaceAll(strings.ReplaceAll(decodeMaybeUTF16(b), "\r", ""), "\x00", "")
	var out []string
	for _, ln := range strings.Split(text, "\n") {
		t := strings.TrimSpace(strings.TrimPrefix(ln, "\ufeff"))
		if t == "" || strings.ContainsAny(t, " \t") {
			continue
		}
		out = append(out, t)
	}
	return out
}
