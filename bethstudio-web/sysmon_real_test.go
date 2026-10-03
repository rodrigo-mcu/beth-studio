package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// TestSysmonRealSample imprime um retrato real desta maquina (so' leitura).
// Roda so' com SYSMON_REAL=1:
//
//	$env:SYSMON_REAL=1; go test -run SysmonRealSample -v .
//
// A lista de terminais vem de `bethstudio.exe cli list --format json` (cliente
// do mux, como a ponte). Este processo de teste solta o console herdado do
// `go test` (so' o dele) para poder ler o titulo dos consoles dos terminais,
// como o bethstudio-web (windowsgui) faz.
func TestSysmonRealSample(t *testing.T) {
	if os.Getenv("SYSMON_REAL") != "1" {
		t.Skip("defina SYSMON_REAL=1")
	}
	exe := resolveExe("")
	var panes []PaneLite
	cmd := exec.Command(exe, "cli", "list", "--format", "json")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	if out, err := cmd.Output(); err == nil {
		var raw []struct {
			PaneID int    `json:"pane_id"`
			Title  string `json:"title"`
			CWD    string `json:"cwd"`
		}
		if json.Unmarshal(out, &raw) == nil {
			gui := guiCommands.get(dataDir())
			for _, r := range raw {
				k := classifyPane(r.PaneID, r.Title, r.CWD, gui, nil)
				panes = append(panes, PaneLite{ID: r.PaneID, Title: r.Title, CWD: r.CWD, Kind: k.Kind, KindLabel: k.Label})
			}
		}
	} else {
		t.Logf("cli list falhou (%s): %v — sem panes", exe, err)
	}
	smFreeConsole.Call() // o console do proprio teste, herdado do go test

	m := newSysmon(func() []PaneLite { return panes })
	m.get()
	time.Sleep(6500 * time.Millisecond) // nvidia-smi e WSL chegam em segundo plano
	b := m.get()
	path := filepath.Join(os.TempDir(), "sysmon-sample.json")
	var pretty map[string]any
	_ = json.Unmarshal(b, &pretty)
	pb, _ := json.MarshalIndent(pretty, "", "  ")
	_ = os.WriteFile(path, pb, 0o644)

	var s SysmonSnapshot
	if err := json.Unmarshal(b, &s); err != nil {
		t.Fatal(err)
	}
	gb := func(v uint64) string { return fmt.Sprintf("%.1f GB", float64(v)/(1<<30)) }
	mb := func(v uint64) string { return fmt.Sprintf("%.0f MB", float64(v)/(1<<20)) }
	var w strings.Builder
	fmt.Fprintf(&w, "amostra em %.1f ms; JSON completo: %s\n", s.SampleMs, path)
	fmt.Fprintf(&w, "RAM %s / %s (%d%%), commit %s / %s, CPU %.1f%% (%d núcleos), uptime %dh, %d processos\n",
		gb(s.System.RAMUsed), gb(s.System.RAMTotal), s.System.RAMLoad, gb(s.System.CommitUsed), gb(s.System.CommitLimit),
		s.System.CPU, len(s.System.Cores), s.System.UptimeSec/3600, s.System.Procs)
	for _, a := range s.GPU.Adapters {
		fmt.Fprintf(&w, "GPU %s [%s]: %.1f%% (%s), dedicada %s, compartilhada %s\n", a.Name, a.LUID, a.Util, a.TopEngine, mb(a.DedicatedUsed), mb(a.SharedUsed))
	}
	for _, n := range s.GPU.Nvidia {
		fmt.Fprintf(&w, "nvidia-smi: %s %.0f°C, %s / %s, %.0f%%\n", n.Name, n.TempC, mb(n.MemUsed), mb(n.MemTotal), n.Util)
	}
	if s.GPU.Note != "" {
		fmt.Fprintf(&w, "GPU: %s\n", s.GPU.Note)
	}
	fmt.Fprintf(&w, "Disco C: livre %s de %s, leitura %.0f KB/s, escrita %.0f KB/s, ativo %.1f%%\n",
		gb(s.Disk.Free), gb(s.Disk.Total), s.Disk.ReadBps/1024, s.Disk.WriteBps/1024, s.Disk.ActivePct)
	for _, p := range s.BethStudio {
		fmt.Fprintf(&w, "Beth Studio %-45s pid %-6d RAM %s (ws %s), CPU %.1f%%, GPU %.1f%%\n", p.Label, p.PID, mb(p.PrivateWS), mb(p.WS), p.CPU, p.GPU)
	}
	fmt.Fprintf(&w, "Associação: %d panes, %d shells; exato %d, aproximado %d, ordem %d, não associado %d; títulos: %v %s\n",
		s.Match.Panes, s.Match.Shells, s.Match.Exact, s.Match.Approx, s.Match.Order, s.Match.Unmatched, s.Match.TitlesAvailable, s.Match.Note)
	for _, x := range s.Terminals {
		id := "-"
		if x.PaneID != nil {
			id = fmt.Sprint(*x.PaneID)
		}
		top := ""
		if len(x.Top) > 0 {
			top = x.Top[0].Name
		}
		fmt.Fprintf(&w, "  pane %-4s %-12s %-40.40q RAM %-7s CPU %4.1f%% procs %-3d top %-14s [%s] console=%q\n",
			id, x.Kind, x.Title, mb(x.PrivateWS), x.CPU, x.Procs, top, x.MatchLabel, x.ConsoleTitle)
	}
	if s.WSL.VM != nil {
		fmt.Fprintf(&w, "WSL VM %s: RAM (ws) %s, CPU %.1f%%\n", s.WSL.VM.Name, gb(s.WSL.VM.WS), s.WSL.VM.CPU)
	}
	if s.WSL.Note != "" {
		fmt.Fprintf(&w, "WSL: %s\n", s.WSL.Note)
	}
	for _, d := range s.WSL.Distros {
		fmt.Fprintf(&w, "distro %s (%s, v%d)", d.Name, d.State, d.Version)
		if d.Mem != nil {
			fmt.Fprintf(&w, ": usado %s de %s, disponível %s, swap %s; load %v", gb(d.Mem.Used), gb(d.Mem.Total), gb(d.Mem.Available), gb(d.Mem.SwapUsed), d.Load)
		}
		if d.Error != "" {
			fmt.Fprintf(&w, " erro: %s", d.Error)
		}
		fmt.Fprintln(&w)
		for i, p := range d.Top {
			if i >= 5 {
				break
			}
			fmt.Fprintf(&w, "    %-8d %-16s %s %.1f%%\n", p.PID, p.Comm, mb(p.RSS), p.PCPU)
		}
	}
	t.Log("\n" + w.String())
}
