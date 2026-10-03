package main

import (
	"encoding/json"
	"testing"
)

func withDefaultDistro(t *testing.T, name string) {
	t.Helper()
	old := defaultWSLDistro
	defaultWSLDistro = func() string { return name }
	t.Cleanup(func() { defaultWSLDistro = old })
}

func TestWslDistroFromUNCAndCwdPath(t *testing.T) {
	cases := map[string]string{
		`\\wsl$\Ubuntu\home\user`:                 "Ubuntu",
		`\\wsl.localhost\Debian\mnt\data`:         "Debian",
		`\\WSL.LOCALHOST\Debian`:                  "Debian",
		`C:\src`:                                  "",
		`\\server\share\x`:                        "",
		cwdPath("file://wsl.localhost/Arch/home"): "Arch",
	}
	for in, want := range cases {
		if got := wslDistroFromUNC(in); got != want {
			t.Errorf("wslDistroFromUNC(%q) = %q, queria %q", in, got, want)
		}
	}
	if got := cwdPath("file://pc/mnt/data/repo"); got != "/mnt/data/repo" {
		t.Errorf("cwdPath = %q", got)
	}
}

func TestPaneWSL(t *testing.T) {
	withDefaultDistro(t, "Padrao")
	// kind wsl com distro do argv
	if ok, d := paneWSL(PaneKind{Kind: "wsl", Distro: "Ubuntu"}, "file://pc/home/u"); !ok || d != "Ubuntu" {
		t.Errorf("wsl + argv: %v %q", ok, d)
	}
	// kind wsl sem distro: a padrao do registro
	if ok, d := paneWSL(PaneKind{Kind: "wsl"}, "file://pc/home/u"); !ok || d != "Padrao" {
		t.Errorf("wsl sem distro: %v %q", ok, d)
	}
	// agente classificado como "other" mas com cwd Linux: e' WSL
	if ok, d := paneWSL(PaneKind{Kind: "other", Agent: true}, "file://pc/mnt/data/repo/proj"); !ok || d != "Padrao" {
		t.Errorf("agente com cwd Linux: %v %q", ok, d)
	}
	// cwd UNC do WSL da' a distro
	if ok, d := paneWSL(PaneKind{Kind: "unknown"}, "file://wsl.localhost/Debian/home/u"); !ok || d != "Debian" {
		t.Errorf("cwd UNC: %v %q", ok, d)
	}
	// Windows, ssh, git bash: nao
	for _, c := range []struct {
		k   PaneKind
		cwd string
	}{
		{PaneKind{Kind: "other"}, "file:///C:/src/app"},
		{PaneKind{Kind: "powershell"}, "file://pc/home/u"},
		{PaneKind{Kind: "ssh"}, "file://remoto/home/u"},
		{PaneKind{Kind: "gitbash"}, "file://pc/c/Users/u"},
	} {
		if ok, _ := paneWSL(c.k, c.cwd); ok {
			t.Errorf("%+v %q não deveria ser WSL", c.k, c.cwd)
		}
	}
}

func TestEnrichListMarksWSLAgentPane(t *testing.T) {
	withDefaultDistro(t, "Padrao")
	list := []byte(`{"ev":"list","panes":[{"pane_id":7,"title":"✳ Claude Code","cwd":"file:///mnt/data/repo/proj"},{"pane_id":8,"title":"PowerShell","cwd":"file:///C:/src"}]}`)
	out := enrichList(list, map[int][]string{}, map[int]string{})
	var ev struct {
		Panes []map[string]any `json:"panes"`
	}
	if err := json.Unmarshal(out, &ev); err != nil {
		t.Fatal(err)
	}
	if ev.Panes[0]["wsl"] != true || ev.Panes[0]["wsl_distro"] != "Padrao" {
		t.Errorf("pane do agente no WSL: %v", ev.Panes[0])
	}
	if _, ok := ev.Panes[1]["wsl"]; ok {
		t.Errorf("pane Windows marcado como WSL: %v", ev.Panes[1])
	}
}

func TestLocalFileWSLUNCPaths(t *testing.T) {
	ok := []string{
		`\\wsl.localhost\Debian\mnt\data\repo\proj\lab\dir\notes.md`,
		`\\wsl$\Debian\home\user\notes.md`,
	}
	for _, p := range ok {
		if _, err := validateLocalPath(p); err != nil {
			t.Errorf("%q deveria ser válido: %v", p, err)
		}
	}
	if _, err := validateLocalPath(`\\wsl.localhost\Debian\home\..\..\x.md`); err == nil {
		t.Error("traversal no UNC do WSL deveria ser recusado")
	}
	if got := wslUNCAlternative(`\\wsl.localhost\Debian\x.md`); got != `\\wsl$\Debian\x.md` {
		t.Errorf("alternativa = %q", got)
	}
	if got := wslUNCAlternative(`\\wsl$\Debian\x.md`); got != `\\wsl.localhost\Debian\x.md` {
		t.Errorf("alternativa = %q", got)
	}
	if got := wslUNCAlternative(`C:\x.md`); got != "" {
		t.Errorf("alternativa de caminho Windows = %q", got)
	}
}
