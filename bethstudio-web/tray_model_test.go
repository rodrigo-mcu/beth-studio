package main

import (
	"strings"
	"testing"
)

func TestTrayMenuOrderAndDefaultItem(t *testing.T) {
	items := trayMenu([]trayShell{{"cmd", "cmd.exe"}, {"wsl.debian", "WSL · Debian"}}, true)
	if items[0].ID != trayOpen || !items[0].Default || items[0].Label != "Beth Studio" {
		t.Fatalf("o primeiro item deve ser o Beth Studio em negrito: %+v", items[0])
	}
	var labels []string
	for _, it := range items {
		if it.Sep {
			labels = append(labels, "---")
		} else {
			labels = append(labels, it.Label)
		}
	}
	want := []string{"Beth Studio", "Novo terminal", "Sistema (CPU, memória, disco)", "Reiniciar interface (terminais continuam)", "---", "Sair da bandeja (terminais continuam)", "Encerrar tudo (fecha os terminais)"}
	if strings.Join(labels, "|") != strings.Join(want, "|") {
		t.Fatalf("itens = %v, quero %v", labels, want)
	}
}

func TestTrayMenuShellSubmenuIDs(t *testing.T) {
	items := trayMenu([]trayShell{{"cmd", "cmd.exe"}, {"wsl.debian", "WSL · Debian"}}, true)
	sub := items[1].Sub
	if len(sub) != 2 || sub[0].ID != trayShellBase || sub[1].ID != trayShellBase+1 || sub[1].Label != "WSL · Debian" {
		t.Fatalf("submenu = %+v", sub)
	}
}

func TestTrayMenuKillAllOnlyWithRunningHost(t *testing.T) {
	for _, it := range trayMenu(nil, false) {
		if it.ID == trayKillAll {
			t.Fatal("sem host rodando não deve oferecer Encerrar tudo")
		}
	}
}

func TestTrayMenuNewTerminalGrayedWithoutHostOrShells(t *testing.T) {
	items := trayMenu(nil, false)
	if !items[1].Grayed || len(items[1].Sub) != 1 || !items[1].Sub[0].Grayed {
		t.Fatalf("sem host: Novo terminal deve estar cinza com aviso: %+v", items[1])
	}
	items = trayMenu(nil, true)
	if items[1].Grayed || !items[1].Sub[0].Grayed {
		t.Fatalf("host rodando mas sem shells: submenu deve ter só o aviso cinza: %+v", items[1])
	}
}

func TestTrayTooltip(t *testing.T) {
	cases := []struct {
		panes, waiting int
		st             hostState
		want           string
	}{
		{0, 0, hostRunning, "Beth Studio — nenhum terminal"},
		{1, 0, hostRunning, "Beth Studio — 1 terminal"},
		{23, 0, hostRunning, "Beth Studio — 23 terminais"},
		{23, 1, hostRunning, "Beth Studio — 23 terminais, 1 agente aguardando você"},
		{23, 3, hostRunning, "Beth Studio — 23 terminais, 3 agentes aguardando você"},
		{0, 0, hostUnavailable, "Beth Studio — host indisponível"},
		{5, 0, hostStarting, "Beth Studio — iniciando o host…"},
		{5, 0, hostQuitting, "Beth Studio — encerrando"},
	}
	for _, c := range cases {
		got := trayTooltip(c.panes, c.waiting, c.st)
		if got != c.want {
			t.Errorf("trayTooltip(%d,%d,%s) = %q, quero %q", c.panes, c.waiting, c.st, got, c.want)
		}
		if n := len([]rune(got)); n > 127 {
			t.Errorf("dica com %d caracteres (máximo 127): %q", n, got)
		}
	}
}

func TestParseTrayShells(t *testing.T) {
	got := parseTrayShells([]byte(`{"ev":"shells","shells":[{"id":"cmd","label":"cmd.exe"},{"id":"wsl.debian","label":"WSL · Debian"}]}`))
	if len(got) != 2 || got[0].ID != "cmd" || got[1].Label != "WSL · Debian" {
		t.Fatalf("shells = %+v", got)
	}
	if parseTrayShells(nil) != nil || parseTrayShells([]byte("não é json")) != nil {
		t.Fatal("entrada vazia ou inválida deve dar lista vazia")
	}
}

func TestHubTrayStats(t *testing.T) {
	h := newHub(false)
	if p, w := h.trayStats(); p != 0 || w != 0 {
		t.Fatalf("hub vazio: %d %d", p, w)
	}
	h.mu.Lock()
	h.lastList = []byte(`{"ev":"list","panes":[{"pane_id":1},{"pane_id":2},{"pane_id":3}]}`)
	h.agents[2] = []byte(`{"ev":"agent","pane_id":2,"waiting":true}`)
	h.mu.Unlock()
	if p, w := h.trayStats(); p != 3 || w != 1 {
		t.Fatalf("trayStats = %d, %d; quero 3, 1", p, w)
	}
}
