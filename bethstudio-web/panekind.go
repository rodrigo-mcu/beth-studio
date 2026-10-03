package main

// panekind.go — tipo de cada terminal (WSL, PowerShell, cmd, ...) para o
// filtro e o agrupamento da barra lateral. A ponte nao informa o comando;
// as fontes sao, em ordem:
//
//  1. pane-commands.json da GUI (wtinator/src/pane_cmd.rs, so' leitura):
//     {"panes":{"<dominio>#<pane id do host>":["wsl.exe","-d","Ubuntu"],...}}
//     O dominio e' o nome do dominio cliente da GUI ("bethstudio-host"); o id
//     e' o id do pane no host, o mesmo que a ponte usa.
//  2. panes criados pelo proprio web (spawn): o shell_id fica em
//     web-settings.json ("spawned"), porque a GUI nao registra esses.
//  3. heuristica: cwd Linux => WSL; titulo com powershell.exe/cmd.exe.
//
// "Agente" (Claude Code etc.) e' uma etiqueta a' parte, pelo titulo.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type PaneKind struct {
	Kind   string `json:"kind"` // wsl | powershell | pwsh | cmd | gitbash | mobaxterm | ssh | other | unknown
	Label  string `json:"kind_label"`
	Distro string `json:"distro,omitempty"`
	Host   string `json:"ssh_host,omitempty"`    // so' ssh: rotulo user@host:port (ou host solto)
	HostID string `json:"ssh_host_id,omitempty"` // so' ssh salvo: id hex do ssh-hosts.json
	Agent  bool   `json:"agent"`
	Source string `json:"kind_source"` // gui | web | heuristic
}

func exeBase(p string) string {
	p = strings.ReplaceAll(p, `\`, "/")
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		p = p[i+1:]
	}
	return strings.ToLower(strings.Trim(p, `"' `))
}

// classifyArgv: tipo pelo comando gravado pela GUI.
func classifyArgv(argv []string) PaneKind {
	if len(argv) == 0 {
		return PaneKind{Kind: "unknown", Label: "Desconhecido"}
	}
	// terminais de ferramenta (bethstudio-tool.exe --ssh|--serial <id>): rotulo endpoint
	if id, ok := sshHostIDForArgv(argv); ok {
		return sshKindSaved(id)
	}
	if l, ok := serialPortForArgv(argv); ok {
		return PaneKind{Kind: "serial", Label: "Serial · " + l}
	}
	exe := exeBase(argv[0])
	low := strings.ToLower(strings.ReplaceAll(argv[0], `\`, "/"))
	switch {
	case exe == "wsl.exe" || exe == "wsl":
		k := PaneKind{Kind: "wsl", Label: "WSL"}
		for i := 1; i < len(argv); i++ {
			a := argv[i]
			if (a == "-d" || a == "--distribution") && i+1 < len(argv) {
				k.Distro = argv[i+1]
				break
			}
			if strings.HasPrefix(a, "--distribution=") {
				k.Distro = strings.TrimPrefix(a, "--distribution=")
				break
			}
		}
		if k.Distro != "" {
			k.Label = "WSL · " + k.Distro
		}
		return k
	case exe == "powershell.exe" || exe == "powershell":
		return PaneKind{Kind: "powershell", Label: "PowerShell 5.1"}
	case exe == "pwsh.exe" || exe == "pwsh":
		return PaneKind{Kind: "pwsh", Label: "PowerShell 7"}
	case exe == "cmd.exe" || exe == "cmd":
		return PaneKind{Kind: "cmd", Label: "cmd"}
	case exe == "git-bash.exe" || ((exe == "bash.exe" || exe == "sh.exe") && strings.Contains(low, "/git/")):
		return PaneKind{Kind: "gitbash", Label: "Git Bash"}
	case strings.Contains(exe, "mobaxterm"):
		return PaneKind{Kind: "mobaxterm", Label: "MobaXterm"}
	case exe == "ssh.exe" || exe == "ssh":
		return sshKind(sshHostFromArgv(argv))
	}
	return PaneKind{Kind: "other", Label: strings.TrimSuffix(exe, ".exe")}
}

// classifyShellID: tipo de um pane criado pelo web (ids de patch 0176).
func classifyShellID(id string) PaneKind {
	if hid, ok := sshHostIDFromShellID(id); ok {
		return sshKindSaved(hid)
	}
	if l, ok := serialPortForShellID(id); ok {
		return PaneKind{Kind: "serial", Label: "Serial · " + l}
	}
	switch {
	case id == "cmd":
		return PaneKind{Kind: "cmd", Label: "cmd"}
	case id == "powershell":
		return PaneKind{Kind: "powershell", Label: "PowerShell 5.1"}
	case id == "pwsh":
		return PaneKind{Kind: "pwsh", Label: "PowerShell 7"}
	case strings.HasPrefix(id, "wsl"):
		k := PaneKind{Kind: "wsl", Label: "WSL"}
		if d := strings.TrimPrefix(id, "wsl."); d != id && d != "default" && d != "" {
			k.Distro = strings.ToUpper(d[:1]) + d[1:]
			k.Label = "WSL · " + k.Distro
		}
		return k
	case strings.HasPrefix(id, "gitbash"):
		return PaneKind{Kind: "gitbash", Label: "Git Bash"}
	case strings.HasPrefix(id, "mobaxterm"):
		return PaneKind{Kind: "mobaxterm", Label: "MobaXterm"}
	case strings.HasPrefix(id, "ssh"):
		return sshKind(strings.ToLower(strings.TrimPrefix(strings.TrimPrefix(id, "ssh"), ".")))
	}
	return PaneKind{Kind: "other", Label: id}
}

// classifyHeuristic: sem registro nenhum.
func classifyHeuristic(title, cwd string) PaneKind {
	t := strings.ToLower(title)
	switch {
	case cwdLooksWSL(cwd):
		return PaneKind{Kind: "wsl", Label: "WSL"}
	case strings.Contains(t, "pwsh.exe"):
		return PaneKind{Kind: "pwsh", Label: "PowerShell 7"}
	case strings.Contains(t, "powershell"):
		return PaneKind{Kind: "powershell", Label: "PowerShell 5.1"}
	case strings.Contains(t, "cmd.exe") || strings.HasPrefix(t, "prompt de comando") || strings.HasPrefix(t, "command prompt"):
		return PaneKind{Kind: "cmd", Label: "cmd"}
	}
	return PaneKind{Kind: "unknown", Label: "Desconhecido"}
}

// agentTitle: Claude Code e afins marcam o titulo com um glifo de status.
func agentTitle(title string) bool {
	r, _ := utf8.DecodeRuneInString(strings.TrimSpace(title))
	switch r {
	case '✳', '✻', '◐', '◑', '◒', '◓', '⏺':
		return true
	}
	return strings.Contains(strings.ToLower(title), "claude")
}

// --- pane-commands.json (GUI) --------------------------------------------

type paneCommands struct {
	mu      sync.Mutex
	checked time.Time
	mtime   time.Time
	byPane  map[int][]string // pane id do host -> argv
}

var guiCommands paneCommands

// get relê o arquivo se a data mudou (no maximo a cada 2 s).
func (pc *paneCommands) get(dir string) map[int][]string {
	pc.mu.Lock()
	defer pc.mu.Unlock()
	if time.Since(pc.checked) < 2*time.Second && pc.byPane != nil {
		return pc.byPane
	}
	pc.checked = time.Now()
	path := filepath.Join(dir, "pane-commands.json")
	st, err := os.Stat(path)
	if err != nil {
		pc.byPane = map[int][]string{}
		pc.mtime = time.Time{}
		return pc.byPane
	}
	if pc.byPane != nil && st.ModTime().Equal(pc.mtime) {
		return pc.byPane
	}
	pc.mtime = st.ModTime()
	pc.byPane = parsePaneCommands(path)
	return pc.byPane
}

// parsePaneCommands: arquivo ausente/corrompido => vazio. Se o mesmo id
// aparece em varios dominios, "bethstudio-host" (o host unico) vence.
func parsePaneCommands(path string) map[int][]string {
	out := map[int][]string{}
	b, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	var doc struct {
		Panes map[string][]string `json:"panes"`
	}
	if json.Unmarshal(b, &doc) != nil {
		return out
	}
	preferred := map[int]bool{}
	for k, argv := range doc.Panes {
		i := strings.LastIndexByte(k, '#')
		if i < 0 {
			continue
		}
		id, err := strconv.Atoi(k[i+1:])
		if err != nil || id < 0 {
			continue
		}
		isMain := k[:i] == "bethstudio-host"
		if _, have := out[id]; have && preferred[id] && !isMain {
			continue
		}
		out[id] = argv
		preferred[id] = isMain
	}
	return out
}

// classifyPane: GUI > web (spawn) > heuristica; + etiqueta de agente.
func classifyPane(id int, title, cwd string, gui map[int][]string, spawned map[int]string) PaneKind {
	var k PaneKind
	if argv, ok := gui[id]; ok && len(argv) > 0 {
		k = classifyArgv(argv)
		k.Source = "gui"
	} else if sh, ok := spawned[id]; ok {
		k = classifyShellID(sh)
		k.Source = "web"
	} else {
		k = classifyHeuristic(title, cwd)
		k.Source = "heuristic"
	}
	// O que o shell informa agora vale mais para shells "Unix" (ssh digitado
	// dentro de um WSL/Git Bash): cwd ou titulo com host remoto = SSH.
	// PowerShell/cmd nao mostram user@host nem OSC 7 remoto: ficam como estao.
	switch k.Kind {
	case "wsl", "gitbash", "mobaxterm", "other", "unknown":
		if h := remoteHost(title, cwd); h != "" {
			src := k.Source
			k = sshKind(h)
			k.Source = src
		}
	case "ssh":
		if k.Host == "" {
			k.Host = remoteHost(title, cwd)
			if k.Host != "" {
				k.Label = "SSH · " + k.Host
			}
		}
	}
	k.Agent = agentTitle(title)
	return k
}

// enrichList acrescenta kind/kind_label/distro/agent a cada pane da lista.
func enrichList(list []byte, gui map[int][]string, spawned map[int]string) []byte {
	var ev map[string]json.RawMessage
	if json.Unmarshal(list, &ev) != nil {
		return list
	}
	var panes []map[string]any
	if json.Unmarshal(ev["panes"], &panes) != nil {
		return list
	}
	for _, p := range panes {
		id, _ := p["pane_id"].(float64)
		title, _ := p["title"].(string)
		cwd, _ := p["cwd"].(string)
		k := classifyPane(int(id), title, cwd, gui, spawned)
		p["kind"], p["kind_label"], p["agent"], p["kind_source"] = k.Kind, k.Label, k.Agent, k.Source
		if k.Distro != "" {
			p["distro"] = k.Distro
		}
		if k.Host != "" {
			p["ssh_host"] = k.Host
		}
		if k.HostID != "" {
			p["ssh_host_id"] = k.HostID
		}
		// links de arquivo na saida (lib/localFile.ts): caminho Linux so' abre
		// se o pane roda no WSL e a distro e' conhecida
		if isWSL, d := paneWSL(k, cwd); isWSL {
			p["wsl"] = true
			if d != "" {
				p["wsl_distro"] = d
			}
		}
	}
	nb, err := json.Marshal(panes)
	if err != nil {
		return list
	}
	ev["panes"] = nb
	out, err := json.Marshal(ev)
	if err != nil {
		return list
	}
	return out
}
