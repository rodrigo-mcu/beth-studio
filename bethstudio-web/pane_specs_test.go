package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

const specsTestList = `{"ev":"list","panes":[
 {"pane_id":7,"title":"build","cwd":"file://PC/home/dev/proj","kind":"wsl","distro":"Debian"},
 {"pane_id":3,"title":"PowerShell","cwd":"file:///C:/Users/dev/work","kind":"powershell"},
 {"pane_id":9,"title":"srv","cwd":"","kind":"ssh","ssh_host_id":"abc123def4567890"},
 {"pane_id":4,"title":"cmd","cwd":"file:///D:/tmp","kind":"cmd"},
 {"pane_id":5,"title":"programa","cwd":"","kind":"other"},
 {"pane_id":6,"title":"ttyUSB","cwd":"","kind":"serial"},
 {"pane_id":8,"title":"wsl ubuntu","cwd":"file://wsl.localhost/Ubuntu/mnt/data/app","kind":"wsl","distro":"Ubuntu"}
]}`

func specByPane(specs []paneSpec, id int) (paneSpec, bool) {
	for _, s := range specs {
		if s.PaneID == id {
			return s, true
		}
	}
	return paneSpec{}, false
}

func TestBuildSpecsByKind(t *testing.T) {
	specs := buildSpecs([]byte(specsTestList), map[int]string{6: "serial.ab12cd34ef567890"}, nil)

	if s, ok := specByPane(specs, 7); !ok || s.ShellID != "wsl.default" || s.Distro != "Debian" || s.Cwd != "/home/dev/proj" || s.Title != "build" {
		t.Errorf("wsl: %+v", s)
	}
	if s, ok := specByPane(specs, 8); !ok || s.Distro != "Ubuntu" || s.Cwd != "/mnt/data/app" {
		t.Errorf("wsl via UNC: %+v", s)
	}
	if s, ok := specByPane(specs, 3); !ok || s.ShellID != "powershell" || s.Cwd != `C:\Users\dev\work` {
		t.Errorf("powershell: %+v", s)
	}
	if s, ok := specByPane(specs, 4); !ok || s.ShellID != "cmd" || s.Cwd != `D:\tmp` {
		t.Errorf("cmd: %+v", s)
	}
	if s, ok := specByPane(specs, 9); !ok || s.Tool == nil || s.Tool.Kind != "ssh" || s.Tool.ID != "abc123def4567890" {
		t.Errorf("ssh: %+v", s)
	}
	if s, ok := specByPane(specs, 6); !ok || s.Tool == nil || s.Tool.Kind != "serial" || s.Tool.ID != "ab12cd34ef567890" {
		t.Errorf("serial: %+v", s)
	}
	if _, ok := specByPane(specs, 5); ok {
		t.Error("terminal de tipo desconhecido não pode entrar na receita")
	}
}

func TestBuildSpecsSerialWithoutKnownIDIsSkipped(t *testing.T) {
	specs := buildSpecs([]byte(specsTestList), nil, nil)
	if _, ok := specByPane(specs, 6); ok {
		t.Error("serial sem perfil conhecido não dá para recriar")
	}
}

func TestBuildSpecsOrderFollowsTheLayout(t *testing.T) {
	layout := &WebLayout{Tabs: []LayoutTab{
		{ID: "a", Root: &LayoutNode{Type: "split", Dir: "row", Children: []*LayoutNode{
			{Type: "leaf", Pane: 8}, {Type: "leaf", Pane: 3},
		}}},
		{ID: "b", Root: &LayoutNode{Type: "leaf", Pane: 7}},
	}}
	specs := buildSpecs([]byte(specsTestList), nil, layout)
	order := map[int]int{}
	for _, s := range specs {
		order[s.PaneID] = s.Order
	}
	if !(order[8] < order[3] && order[3] < order[7]) {
		t.Fatalf("ordem do layout não respeitada: %v", order)
	}
	// o que não está no layout vem depois, por id
	if !(order[7] < order[4] && order[4] < order[9]) {
		t.Fatalf("terminais fora do layout deveriam vir depois, por id: %v", order)
	}
}

func TestWSLLinuxCwd(t *testing.T) {
	cases := map[string]string{
		"file://PC/home/dev/proj":              "/home/dev/proj",
		"file://wsl.localhost/Debian/home/dev": "/home/dev",
		"file://wsl$/Ubuntu/mnt/c/Users":       "/mnt/c/Users",
		"file:///C:/Users/dev":                 "/mnt/c/Users/dev",
		`\\wsl.localhost\Debian\home\dev\a b`:  "/home/dev/a b",
		"/home/ja/linux":                       "/home/ja/linux",
		"":                                     "",
		"file://PC/":                           "/",
	}
	for in, want := range cases {
		if got := wslLinuxCwd(in); got != want {
			t.Errorf("wslLinuxCwd(%q) = %q, quero %q", in, got, want)
		}
	}
}

func TestWindowsCwd(t *testing.T) {
	cases := map[string]string{
		"file:///C:/Users/dev/work": `C:\Users\dev\work`,
		"file:///d:/x":              `d:\x`,
		`C:\Users\dev`:              `C:\Users\dev`,
		"":                          "",
		"file://PC/home/x":          "", // pasta Linux não vale para shell do Windows
	}
	for in, want := range cases {
		if got := windowsCwd(in); got != want {
			t.Errorf("windowsCwd(%q) = %q, quero %q", in, got, want)
		}
	}
}

func TestShouldRestore(t *testing.T) {
	now := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	fresh := specsFile{HostID: "100@1", SavedAt: now.Add(-time.Hour).Format(time.RFC3339), Specs: []paneSpec{{PaneID: 1}}}
	if !shouldRestore(fresh, "200@2", 0, now) {
		t.Fatal("host novo, lista vazia, receita recente: deveria restaurar")
	}
	if shouldRestore(fresh, "100@1", 0, now) {
		t.Fatal("mesmo host com lista vazia (usuário fechou tudo): não pode restaurar")
	}
	if shouldRestore(fresh, "200@2", 3, now) {
		t.Fatal("já há terminais no host novo: não restaura")
	}
	if shouldRestore(specsFile{HostID: "100@1", SavedAt: now.Format(time.RFC3339)}, "200@2", 0, now) {
		t.Fatal("receita vazia não restaura nada")
	}
	old := fresh
	old.SavedAt = now.Add(-8 * 24 * time.Hour).Format(time.RFC3339)
	if shouldRestore(old, "200@2", 0, now) {
		t.Fatal("receita com mais de 7 dias não vale")
	}
	if shouldRestore(fresh, "", 0, now) {
		t.Fatal("sem identidade do host atual não dá para decidir")
	}
	noID := fresh
	noID.HostID = ""
	if shouldRestore(noID, "200@2", 0, now) {
		t.Fatal("receita sem identidade de host não restaura")
	}
}

func TestSaveAndLoadSpecs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "pane-specs.json")
	in := specsFile{Version: 1, SavedAt: "2026-10-03T12:00:00Z", HostID: "100@1", Specs: []paneSpec{
		{PaneID: 7, ShellID: "wsl.default", Distro: "Debian", Cwd: "/home/dev", Order: 2},
		{PaneID: 9, Tool: &toolSpec{Kind: "ssh", ID: "abc"}},
	}}
	if err := saveSpecs(path, in); err != nil {
		t.Fatal(err)
	}
	out, ok := loadSpecs(path)
	if !ok || out.HostID != "100@1" || len(out.Specs) != 2 || out.Specs[1].Tool == nil || out.Specs[1].Tool.ID != "abc" {
		t.Fatalf("round trip falhou: %+v ok=%v", out, ok)
	}
	if _, err := os.Stat(path + ".tmp"); err == nil {
		t.Fatal("sobrou arquivo temporário")
	}
}

func TestLoadSpecsCorruptedOrMissing(t *testing.T) {
	dir := t.TempDir()
	if _, ok := loadSpecs(filepath.Join(dir, "nao-existe.json")); ok {
		t.Fatal("arquivo ausente deveria dar false")
	}
	bad := filepath.Join(dir, "ruim.json")
	_ = os.WriteFile(bad, []byte("{ não é json"), 0o644)
	if _, ok := loadSpecs(bad); ok {
		t.Fatal("arquivo corrompido deveria dar false")
	}
}

func TestLoadSpecsToleratesUTF8BOM(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pane-specs.json")
	body := append([]byte{0xEF, 0xBB, 0xBF}, []byte(`{"version":1,"host_id":"1@1","saved_at":"2026-10-03T12:00:00Z","specs":[{"pane_id":4,"kind":"cmd","order":0}]}`)...)
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatal(err)
	}
	f, ok := loadSpecs(path)
	if !ok || f.HostID != "1@1" || len(f.Specs) != 1 || f.Specs[0].PaneID != 4 {
		t.Fatalf("receita com BOM deveria ser lida: %+v ok=%v", f, ok)
	}
}
