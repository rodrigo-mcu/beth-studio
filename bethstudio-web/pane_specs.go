package main

// pane_specs.go — a "receita" de cada terminal vivo (shell, pasta, distro,
// ferramenta), gravada em %APPDATA%\bethstudio\pane-specs.json. Se o host cair e
// voltar vazio, o Studio recria os terminais a partir dela (restore.go).

import (
	"bytes"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	specsVersion = 1
	specsMaxAge  = 7 * 24 * time.Hour
)

type toolSpec struct {
	Kind string `json:"kind"` // ssh | serial
	ID   string `json:"id"`
}

type paneSpec struct {
	PaneID  int       `json:"pane_id"`
	ShellID string    `json:"shell_id,omitempty"`
	Kind    string    `json:"kind"`
	Distro  string    `json:"distro,omitempty"`
	Cwd     string    `json:"cwd,omitempty"` // WSL: pasta Linux; outros: pasta do Windows
	Title   string    `json:"title,omitempty"`
	Tool    *toolSpec `json:"tool,omitempty"`
	Order   int       `json:"order"`
	// Só em terminal pendente (restore_pending.go): quem ele era antes de a receita deslocar o
	// id. Sem isso, um segundo reinício perde a folha do layout, o nome de aba e a aparência.
	OrigPane int             `json:"orig_pane,omitempty"`
	OrigHost string          `json:"orig_host,omitempty"`
	OrigName *PaneName       `json:"orig_name,omitempty"`
	OrigLook *PaneAppearance `json:"orig_look,omitempty"`
}

type specsFile struct {
	Version int        `json:"version"`
	SavedAt string     `json:"saved_at"`
	HostID  string     `json:"host_id"`
	Specs   []paneSpec `json:"specs"`
}

var (
	winDriveRe    = regexp.MustCompile(`^/?([A-Za-z]):[\\/]?(.*)$`)
	serialShellRe = regexp.MustCompile(`^serial\.([0-9a-f]{16})$`)
)

// wslLinuxCwd converte a pasta de um terminal WSL (OSC 7, UNC ou caminho) em
// caminho Linux. Vazio quando não dá para saber.
func wslLinuxCwd(cwd string) string {
	if cwd == "" {
		return ""
	}
	p := cwdPath(cwd)
	low := strings.ToLower(p)
	for _, pre := range []string{`\\wsl$\`, `\\wsl.localhost\`} {
		if strings.HasPrefix(low, pre) {
			rest := p[len(pre):]
			if i := strings.IndexAny(rest, `\/`); i >= 0 {
				return strings.ReplaceAll(rest[i:], `\`, "/")
			}
			return "/"
		}
	}
	if m := winDriveRe.FindStringSubmatch(p); m != nil {
		return "/mnt/" + strings.ToLower(m[1]) + "/" + strings.ReplaceAll(m[2], `\`, "/")
	}
	if strings.HasPrefix(p, "/") {
		return p
	}
	return ""
}

// windowsCwd: pasta do Windows de um terminal PowerShell/cmd/Git Bash.
func windowsCwd(cwd string) string {
	if cwd == "" {
		return ""
	}
	p := cwdPath(cwd)
	if m := winDriveRe.FindStringSubmatch(p); m != nil {
		return m[1] + `:\` + strings.ReplaceAll(m[2], "/", `\`)
	}
	return ""
}

var windowsShells = map[string]string{
	"powershell": "powershell",
	"pwsh":       "pwsh",
	"cmd":        "cmd",
	"gitbash":    "gitbash",
}

// buildSpecs monta as receitas a partir da lista (já com os tipos), dos shells
// que o Studio criou e da ordem do layout.
func buildSpecs(list []byte, spawned map[int]string, layout *WebLayout) []paneSpec {
	var ev struct {
		Panes []struct {
			PaneID    int    `json:"pane_id"`
			Title     string `json:"title"`
			Cwd       string `json:"cwd"`
			Kind      string `json:"kind"`
			Distro    string `json:"distro"`
			SSHHostID string `json:"ssh_host_id"`
		} `json:"panes"`
	}
	if json.Unmarshal(list, &ev) != nil {
		return nil
	}
	order := map[int]int{}
	n := 0
	forEachLeaf(layout, func(l *LayoutNode) {
		if l.Gone {
			return
		}
		if _, dup := order[l.Pane]; !dup {
			order[l.Pane] = n
			n++
		}
	})
	var specs []paneSpec
	for _, p := range ev.Panes {
		s := paneSpec{PaneID: p.PaneID, Kind: p.Kind, Title: p.Title}
		switch {
		case p.Kind == "wsl":
			s.ShellID, s.Distro, s.Cwd = "wsl.default", p.Distro, wslLinuxCwd(p.Cwd)
		case windowsShells[p.Kind] != "":
			s.ShellID, s.Cwd = windowsShells[p.Kind], windowsCwd(p.Cwd)
		case p.Kind == "ssh" && p.SSHHostID != "":
			s.Tool = &toolSpec{Kind: "ssh", ID: p.SSHHostID}
		case p.Kind == "serial":
			m := serialShellRe.FindStringSubmatch(spawned[p.PaneID])
			if m == nil {
				continue // sem o perfil não dá para recriar
			}
			s.Tool = &toolSpec{Kind: "serial", ID: m[1]}
		default:
			continue
		}
		specs = append(specs, s)
	}
	// ordem do layout; o que não está nele vem depois, por id
	sort.SliceStable(specs, func(i, j int) bool {
		oi, iok := order[specs[i].PaneID]
		oj, jok := order[specs[j].PaneID]
		switch {
		case iok && jok:
			return oi < oj
		case iok != jok:
			return iok
		}
		return specs[i].PaneID < specs[j].PaneID
	})
	for i := range specs {
		specs[i].Order = i
	}
	return specs
}

// saveSpecs grava de forma atômica (arquivo temporário + rename).
func saveSpecs(path string, f specsFile) error {
	if f.Version == 0 {
		f.Version = specsVersion
	}
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// stripBOM tira o BOM UTF-8: o Bloco de Notas e o Windows PowerShell 5.1 o gravam, e o
// encoding/json o recusa ("invalid character 'ï'").
func stripBOM(b []byte) []byte { return bytes.TrimPrefix(b, []byte{0xEF, 0xBB, 0xBF}) }

var lastSpecsErr string

func loadSpecs(path string) (specsFile, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return specsFile{}, false
	}
	var f specsFile
	if err := json.Unmarshal(stripBOM(b), &f); err != nil {
		// avisa uma vez por erro (a lista chega a cada 2 s)
		if msg := err.Error(); msg != lastSpecsErr {
			lastSpecsErr = msg
			log.Printf("restore: %s ilegível (%v); a receita dos terminais será ignorada até ser regravada", path, err)
		}
		return specsFile{}, false
	}
	return f, true
}

func specsPath() string { return filepath.Join(dataDir(), "pane-specs.json") }

// shouldRestore: o host é OUTRO processo que o da receita, está vazio, a
// receita não está vazia e tem menos de 7 dias. Terminal fechado de propósito
// (mesmo host, lista vazia) nunca ressuscita.
func shouldRestore(f specsFile, hostID string, panes int, now time.Time) bool {
	if panes != 0 || len(f.Specs) == 0 || hostID == "" || f.HostID == "" || f.HostID == hostID {
		return false
	}
	t, err := time.Parse(time.RFC3339, f.SavedAt)
	if err != nil || now.Sub(t) > specsMaxAge {
		return false
	}
	return true
}

// brokenWSLStart: terminal WSL cujo processo ainda e' o "wslhost.exe" do relay:
// o shell nunca subiu (a pasta nao existia, o disco nao estava montado) e a
// pasta que ele informa ("/") nao e' a de trabalho do usuario.
func brokenWSLStart(s paneSpec) bool {
	return s.Kind == "wsl" && strings.EqualFold(strings.TrimSpace(s.Title), "wslhost.exe")
}

// carryCwds: a pasta de trabalho que a receita antiga tinha para cada terminal
// WSL restaurado (chave = id novo), para a receita nova nao a perder se o
// terminal abrir quebrado.
func carryCwds(old []paneSpec, idMap map[int]int) map[int]string {
	out := map[int]string{}
	for _, s := range old {
		nid, ok := idMap[s.PaneID]
		if !ok || s.Kind != "wsl" || s.Cwd == "" || s.Cwd == "/" || s.Cwd == "~" {
			continue
		}
		out[nid] = s.Cwd
	}
	return out
}

// applyCarry: enquanto o terminal continua quebrado, a receita guarda a pasta
// de antes (em vez do "/" que ele informa). Quando o shell sobe de verdade, a
// pasta viva volta a valer e a lembranca some.
func applyCarry(specs []paneSpec, carry map[int]string) {
	for i := range specs {
		keep, ok := carry[specs[i].PaneID]
		if !ok {
			continue
		}
		if brokenWSLStart(specs[i]) {
			specs[i].Cwd = keep
		} else {
			delete(carry, specs[i].PaneID)
		}
	}
}
