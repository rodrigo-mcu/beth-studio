// fakebridge: a stand-in for `bethstudio.exe cli bridge` for UI tests. It
// never talks to a real host. Run bethstudio-web with
//
//	--bethstudio <path>\fakebridge.exe
//
// It serves 3 fake panes, answers list/watch/scroll with synthetic screens,
// emits "agent waiting" for pane 2 after 1 s (reason user_var) and for pane
// 3 after 2 s (reason bell), lists the GUI shells and "spawns" new panes
// (pane ids from 100) that then appear in the list. send/paste on a pane
// clears its agent alert (reason input), like the real bridge.
// spawn_tool {kind:"ssh"|"serial", id} validates like the real bridge op
// (docs/INTEGRATION-ssh.md) and adds a fake "SSH · <id>"/"Serial · <id>" pane.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type pane struct {
	WindowID    int            `json:"window_id"`
	TabID       int            `json:"tab_id"`
	PaneID      int            `json:"pane_id"`
	Workspace   string         `json:"workspace"`
	Size        map[string]int `json:"size"`
	Title       string         `json:"title"`
	Cwd         string         `json:"cwd"`
	TabTitle    string         `json:"tab_title"`
	WindowTitle string         `json:"window_title"`
	IsActive    bool           `json:"is_active"`
}

var (
	mu    sync.Mutex
	out   = bufio.NewWriter(os.Stdout)
	panes = []pane{
		{0, 0, 1, "default", map[string]int{"rows": 20, "cols": 80}, "Windows PowerShell", "file:///C:/src/repo/app/", "", "Janela A", true},
		{0, 1, 2, "default", map[string]int{"rows": 20, "cols": 80}, "✳ Claude Code — refatorar", "file://pc/mnt/data/src/repo/api-server/", "", "Janela A", true},
		{1, 2, 3, "default", map[string]int{"rows": 20, "cols": 80}, "user@pc: ~/infra", "file://pc/home/user/infra/", "", "Janela B", true},
		{1, 2, 4, "default", map[string]int{"rows": 20, "cols": 40}, "split vizinho", "file://pc/home/user/", "", "Janela B", false},
	}
	watched  = map[int]bool{}
	toolIDRe = regexp.MustCompile(`^[a-f0-9]{16}$`)
	nextPane = 100
	nextTab  = 50
)

func emit(v any) {
	b, _ := json.Marshal(v)
	mu.Lock()
	out.Write(b)
	out.WriteByte('\n')
	out.Flush()
	mu.Unlock()
}

func list() {
	mu.Lock()
	cp := append([]pane{}, panes...)
	mu.Unlock()
	emit(map[string]any{"ev": "list", "panes": cp})
}

func sizeOf(id int) (int, int) {
	mu.Lock()
	defer mu.Unlock()
	for _, p := range panes {
		if p.PaneID == id {
			return p.Size["cols"], p.Size["rows"]
		}
	}
	return 80, 20
}

func screen(id int) {
	cols, nrows := sizeOf(id)
	var rows []string
	for i := 0; i < nrows; i++ {
		if i == 0 {
			rows = append(rows, "rl0g@ {}[] => iIl1 0Oo ~/$ ç ã")
			continue
		}
		// FAKE_LINK_FILE=<caminho Windows de um .md>: a linha 2 do pane 1 mostra
		// um hyperlink OSC 8 para ele e o mesmo caminho solto (teste do preview)
		if f := os.Getenv("FAKE_LINK_FILE"); f != "" && id == 1 && i == 2 {
			uri := "file:///" + strings.ReplaceAll(f, "\\", "/")
			rows = append(rows, fmt.Sprintf("salvo em \x1b]8;;%s\x07notas\x1b]8;;\x07 (%s). Fim.", uri, f))
			continue
		}
		rows = append(rows, fmt.Sprintf("\x1b[32mfake pane %d\x1b[0m linha %d", id, i))
	}
	emit(map[string]any{"ev": "screen", "pane_id": id, "cols": cols, "rows": nrows, "cursor_x": 0, "cursor_y": nrows - 1,
		"cursor_visible": true, "offset": 0, "scrollback": 0, "text": strings.Join(rows, "\r\n")})
}

func main() {
	// FAKE_CLOSE_PANE=N: simula o usuario fechando o pane N depois de 8 s
	// (patch 0179: pane_gone se observado + lista nova).
	if v := os.Getenv("FAKE_CLOSE_PANE"); v != "" {
		go func() {
			time.Sleep(8 * time.Second)
			var id int
			fmt.Sscan(v, &id)
			mu.Lock()
			for i, p := range panes {
				if p.PaneID == id {
					panes = append(panes[:i], panes[i+1:]...)
					break
				}
			}
			w := watched[id]
			delete(watched, id)
			mu.Unlock()
			if w {
				emit(map[string]any{"ev": "pane_gone", "pane_id": id})
			}
			list()
			fmt.Fprintf(os.Stderr, "fakebridge: pane %d fechado (observado=%v)\n", id, w)
		}()
	}
	go func() {
		time.Sleep(time.Second)
		emit(map[string]any{"ev": "agent", "pane_id": 2, "waiting": true, "reason": "user_var", "detail": "claude_status=waiting"})
		time.Sleep(time.Second)
		emit(map[string]any{"ev": "agent", "pane_id": 3, "waiting": true, "reason": "bell", "detail": ""})
	}()
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		var r struct {
			Op      string `json:"op"`
			PaneID  *int   `json:"pane_id"`
			PaneIDs []int  `json:"pane_ids"`
			ShellID string `json:"shell_id"`
			Window  *int   `json:"window_id"`
			Cwd     string `json:"cwd"`
			ReqID   string `json:"request_id"`
		}
		if json.Unmarshal(sc.Bytes(), &r) != nil {
			continue
		}
		switch r.Op {
		case "list":
			list()
		case "watch":
			watched = map[int]bool{}
			ids := r.PaneIDs
			if r.PaneID != nil {
				ids = append(ids, *r.PaneID)
			}
			for _, id := range ids {
				watched[id] = true
				screen(id)
			}
		case "send", "paste":
			if r.PaneID != nil {
				emit(map[string]any{"ev": "agent", "pane_id": *r.PaneID, "waiting": false, "reason": "input"})
			}
		case "resize":
			var rr struct {
				PaneID int `json:"pane_id"`
				Cols   int `json:"cols"`
				Rows   int `json:"rows"`
			}
			_ = json.Unmarshal(sc.Bytes(), &rr)
			mu.Lock()
			tab, n := -1, 0
			for _, p := range panes {
				if p.PaneID == rr.PaneID {
					tab = p.TabID
				}
			}
			for _, p := range panes {
				if p.TabID == tab {
					n++
				}
			}
			ok := n == 1 && os.Getenv("FAKE_REFUSE") == ""
			if ok {
				for i := range panes {
					if panes[i].PaneID == rr.PaneID {
						panes[i].Size = map[string]int{"cols": rr.Cols, "rows": rr.Rows}
					}
				}
			}
			mu.Unlock()
			fmt.Fprintf(os.Stderr, "fakebridge: resize pane %d -> %dx%d ok=%v\n", rr.PaneID, rr.Cols, rr.Rows, ok)
			if !ok {
				emit(map[string]any{"ev": "error", "message": fmt.Sprintf("resize: pane %d shares its Beth Studio tab with %d other pane(s)", rr.PaneID, max(n-1, 1))})
				continue
			}
			list()
			if watched[rr.PaneID] {
				screen(rr.PaneID)
			}
		case "separate":
			var sr struct {
				PaneID int `json:"pane_id"`
			}
			_ = json.Unmarshal(sc.Bytes(), &sr)
			mu.Lock()
			tab, n, idx := -1, 0, -1
			for i, p := range panes {
				if p.PaneID == sr.PaneID {
					tab, idx = p.TabID, i
				}
			}
			for _, p := range panes {
				if p.TabID == tab {
					n++
				}
			}
			var win int
			if idx >= 0 && n > 1 {
				nextTab++
				panes[idx].TabID = nextTab
				win = panes[idx].WindowID
			}
			newTab := nextTab
			mu.Unlock()
			fmt.Fprintf(os.Stderr, "fakebridge: separate pane %d (dividia a aba com %d)\n", sr.PaneID, n-1)
			if idx < 0 || n <= 1 {
				emit(map[string]any{"ev": "error", "message": fmt.Sprintf("separate: pane %d is already alone in its Beth Studio tab", sr.PaneID)})
				continue
			}
			list()
			emit(map[string]any{"ev": "separated", "pane_id": sr.PaneID, "tab_id": newTab, "window_id": win})
		case "kill":
			var kr struct {
				PaneID int `json:"pane_id"`
			}
			_ = json.Unmarshal(sc.Bytes(), &kr)
			mu.Lock()
			for i, p := range panes {
				if p.PaneID == kr.PaneID {
					panes = append(panes[:i], panes[i+1:]...)
					break
				}
			}
			w := watched[kr.PaneID]
			delete(watched, kr.PaneID)
			mu.Unlock()
			fmt.Fprintf(os.Stderr, "fakebridge: kill pane %d\n", kr.PaneID)
			if w {
				emit(map[string]any{"ev": "pane_gone", "pane_id": kr.PaneID})
			}
			list()
		case "shells":
			emit(map[string]any{"ev": "shells", "shells": []map[string]string{
				{"id": "cmd", "label": "Prompt de comando"}, {"id": "powershell", "label": "PowerShell 5.1"},
				{"id": "pwsh", "label": "PowerShell 7"}, {"id": "wsl.default", "label": "WSL (padrão)"},
				{"id": "wsl.ubuntu", "label": "WSL Ubuntu"}, {"id": "gitbash", "label": "Git Bash"},
				{"id": "mobaxterm.local", "label": "MobaXterm"}, {"id": "app.debug", "label": "App (log)"},
			}})
		case "spawn_tool":
			// Terminal de ferramenta (docs/INTEGRATION-ssh.md): a ponte real
			// monta `<pasta do bethstudio.exe>\bethstudio-tool.exe --ssh|--serial <id>`;
			// aqui so' valida como ela e cria um pane falso.
			var tr struct {
				Kind string `json:"kind"`
				ID   string `json:"id"`
			}
			_ = json.Unmarshal(sc.Bytes(), &tr)
			flag := map[string]string{"ssh": "--ssh", "serial": "--serial"}[tr.Kind]
			if flag == "" || !toolIDRe.MatchString(tr.ID) {
				emit(map[string]any{"ev": "error", "message": fmt.Sprintf("spawn_tool %s (request %s): invalid kind or id", tr.Kind, r.ReqID)})
				continue
			}
			mu.Lock()
			w := 9
			if r.Window != nil {
				w = *r.Window
			}
			id := nextPane
			nextPane++
			nextTab++
			title := map[string]string{"ssh": "SSH · ", "serial": "Serial · "}[tr.Kind] + tr.ID
			panes = append(panes, pane{w, nextTab, id, "default", map[string]int{"rows": 20, "cols": 80},
				title, "", "", "Janela nova", true})
			mu.Unlock()
			list()
			emit(map[string]any{"ev": "spawned", "request_id": r.ReqID, "pane_id": id, "tab_id": nextTab, "window_id": w})
			fmt.Fprintf(os.Stderr, "fakebridge: spawn_tool bethstudio-tool.exe %s %s -> pane %d\n", flag, tr.ID, id)
		case "spawn":
			if r.ShellID == "falhar" {
				emit(map[string]any{"ev": "error", "message": fmt.Sprintf("spawn %s (request %s): falha simulada", r.ShellID, r.ReqID)})
				continue
			}
			// FAKE_SPAWN_DELAY_MS: demora para ver o "abrindo…" (e o tempo esgotado)
			if ms, err := strconv.Atoi(os.Getenv("FAKE_SPAWN_DELAY_MS")); err == nil && ms > 0 {
				time.Sleep(time.Duration(ms) * time.Millisecond)
			}
			mu.Lock()
			w := 9
			if r.Window != nil {
				w = *r.Window
			}
			id := nextPane
			nextPane++
			nextTab++
			panes = append(panes, pane{w, nextTab, id, "default", map[string]int{"rows": 20, "cols": 80},
				"novo " + r.ShellID, "file:///" + strings.ReplaceAll(r.Cwd, "\\", "/"), "", "Janela nova", true})
			mu.Unlock()
			list()
			emit(map[string]any{"ev": "spawned", "request_id": r.ReqID, "pane_id": id, "tab_id": nextTab, "window_id": w})
			fmt.Fprintf(os.Stderr, "fakebridge: spawn shell=%s window=%v cwd=%q -> pane %d\n", r.ShellID, r.Window, r.Cwd, id)
		}
	}
}
