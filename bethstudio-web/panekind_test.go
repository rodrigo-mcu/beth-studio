package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClassifyArgv(t *testing.T) {
	cases := []struct {
		argv        []string
		kind, label string
		distro      string
	}{
		{[]string{"powershell.exe", "-NoLogo"}, "powershell", "PowerShell 5.1", ""},
		{[]string{`C:\Program Files\PowerShell\7\pwsh.exe`}, "pwsh", "PowerShell 7", ""},
		{[]string{"wsl.exe"}, "wsl", "WSL", ""},
		{[]string{"wsl.exe", "-d", "Ubuntu-22.04"}, "wsl", "WSL · Ubuntu-22.04", "Ubuntu-22.04"},
		{[]string{"wsl", "--distribution=Debian", "--cd", "~"}, "wsl", "WSL · Debian", "Debian"},
		{[]string{"cmd.exe", "/k"}, "cmd", "cmd", ""},
		{[]string{`C:\Program Files\Git\bin\bash.exe`, "--login"}, "gitbash", "Git Bash", ""},
		{[]string{`C:\Program Files\Git\git-bash.exe`}, "gitbash", "Git Bash", ""},
		{[]string{`C:\tools\MobaXterm\MobaXterm.exe`}, "mobaxterm", "MobaXterm", ""},
		{[]string{"node.exe", "log.js"}, "other", "node", ""},
		{nil, "unknown", "Desconhecido", ""},
	}
	for _, c := range cases {
		k := classifyArgv(c.argv)
		if k.Kind != c.kind || k.Label != c.label || k.Distro != c.distro {
			t.Errorf("%v => %+v, want %s/%s/%s", c.argv, k, c.kind, c.label, c.distro)
		}
	}
}

func TestClassifyShellIDAndHeuristics(t *testing.T) {
	if k := classifyShellID("wsl.ubuntu"); k.Kind != "wsl" || k.Label != "WSL · Ubuntu" {
		t.Fatalf("wsl.ubuntu => %+v", k)
	}
	if k := classifyShellID("wsl.default"); k.Label != "WSL" || k.Distro != "" {
		t.Fatalf("wsl.default => %+v", k)
	}
	if k := classifyShellID("pwsh"); k.Kind != "pwsh" {
		t.Fatalf("pwsh => %+v", k)
	}
	if k := classifyShellID("app.debug"); k.Kind != "other" {
		t.Fatalf("app.debug => %+v", k)
	}
	h := []struct{ title, cwd, kind string }{
		{"user@pc: ~", "file://pc/home/user", "wsl"},
		{"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "file:///C:/x/", "powershell"},
		{"Windows PowerShell", "file:///C:/x/", "powershell"},
		{"C:\\Windows\\system32\\cmd.exe", "", "cmd"},
		{"algo", "file:///C:/x/", "unknown"},
	}
	for _, c := range h {
		if k := classifyHeuristic(c.title, c.cwd); k.Kind != c.kind {
			t.Errorf("heuristic %q %q => %s, want %s", c.title, c.cwd, k.Kind, c.kind)
		}
	}
	for _, s := range []string{"✳ Conexão master", "⏺ pensando", "◐ API VMS", "Claude Code"} {
		if !agentTitle(s) {
			t.Errorf("agent %q", s)
		}
	}
	if agentTitle("Windows PowerShell") {
		t.Error("not an agent")
	}
}

func TestPaneCommandsFileAndPriority(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pane-commands.json")
	// ausente => vazio
	if got := parsePaneCommands(path); len(got) != 0 {
		t.Fatalf("missing file => %v", got)
	}
	// corrompido => vazio
	_ = os.WriteFile(path, []byte("{nao json"), 0o644)
	if got := parsePaneCommands(path); len(got) != 0 {
		t.Fatalf("corrupt file => %v", got)
	}
	doc := map[string]any{"panes": map[string][]string{
		"bethstudio-host#10":      {"powershell.exe", "-NoLogo"},
		"bethstudio-host#12":      {"wsl.exe", "-d", "Ubuntu"},
		"bethstudio-host-w1-2#12": {"cmd.exe"}, // outro dominio: o host unico vence
		"lixo":                  {"x"},
		"bethstudio-host#abc":     {"x"},
	}}
	b, _ := json.Marshal(doc)
	_ = os.WriteFile(path, b, 0o644)
	got := parsePaneCommands(path)
	if len(got) != 2 || got[10][0] != "powershell.exe" || got[12][0] != "wsl.exe" {
		t.Fatalf("parsed => %v", got)
	}
	// prioridade: GUI > web (spawn) > heuristica; agente e' etiqueta a' parte
	spawned := map[int]string{12: "cmd", 40: "wsl.ubuntu"}
	if k := classifyPane(12, "✳ Claude", "", got, spawned); k.Kind != "wsl" || k.Source != "gui" || !k.Agent || k.Distro != "Ubuntu" {
		t.Fatalf("pane 12 => %+v", k)
	}
	if k := classifyPane(40, "x", "", got, spawned); k.Label != "WSL · Ubuntu" || k.Source != "web" {
		t.Fatalf("pane 40 => %+v", k)
	}
	host, _ := os.Hostname() // cwd do WSL traz o nome da propria maquina
	if k := classifyPane(41, "x", "file://"+strings.ToLower(host)+"/home/r", got, spawned); k.Kind != "wsl" || k.Source != "heuristic" {
		t.Fatalf("pane 41 => %+v", k)
	}
	// enrichList acrescenta os campos sem perder os outros
	list := []byte(`{"ev":"list","panes":[{"pane_id":10,"title":"PS","cwd":"file:///C:/x/","tab_id":3}]}`)
	var ev struct {
		Ev    string           `json:"ev"`
		Panes []map[string]any `json:"panes"`
	}
	if err := json.Unmarshal(enrichList(list, got, spawned), &ev); err != nil {
		t.Fatal(err)
	}
	p := ev.Panes[0]
	if ev.Ev != "list" || p["kind"] != "powershell" || p["kind_label"] != "PowerShell 5.1" || p["tab_id"].(float64) != 3 || p["agent"] != false {
		t.Fatalf("enriched => %v", p)
	}
}

func TestSpawnedRecordedPerHost(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "host.pid"), []byte("111"), 0o644)
	st := &settingsStore{}
	st.load(dir)
	st.recordSpawn(40, "wsl.ubuntu")
	if m := st.spawnedMap(); m[40] != "wsl.ubuntu" {
		t.Fatalf("spawned = %v", m)
	}
	// outro host (pid novo): o registro antigo nao vale
	_ = os.WriteFile(filepath.Join(dir, "host.pid"), []byte("222"), 0o644)
	st2 := &settingsStore{}
	st2.load(dir)
	if m := st2.spawnedMap(); len(m) != 0 {
		t.Fatalf("old host spawned leaked: %v", m)
	}
	if _, err := st2.setSidebar(SidebarPrefs{View: "kind", Kinds: []string{"wsl", "agent"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := st2.setSidebar(SidebarPrefs{View: "folder"}); err != nil { // "Por pasta"
		t.Fatal(err)
	}
	if _, err := st2.setSidebar(SidebarPrefs{View: "kind", Kinds: []string{"wsl", "agent"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := st2.setSidebar(SidebarPrefs{View: "outra"}); err == nil {
		t.Fatal("invalid view accepted")
	}
	st3 := &settingsStore{}
	st3.load(dir)
	if s := st3.snapshot(); s.Sidebar.View != "kind" || len(s.Sidebar.Kinds) != 2 {
		t.Fatalf("sidebar = %+v", s.Sidebar)
	}
}
