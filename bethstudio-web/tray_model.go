package main

// tray_model.go — o menu e a dica da bandeja do Studio, sem Win32 (testável).

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync/atomic"
)

// Ids dos comandos do menu da bandeja.
const (
	trayOpen      = 1
	trayTasks     = 2
	trayQuitTray  = 3
	trayKillAll   = 4
	trayReload    = 5
	trayShellBase = 100 // + índice do shell
)

// Estado compartilhado entre a janela principal e a bandeja.
var (
	// quitRequested: a saída foi pedida (bandeja); a janela deixa de apenas esconder.
	quitRequested atomic.Bool
	// trayActive: existe um ícone na bandeja; só então fechar a janela esconde.
	trayActive atomic.Bool
)

type trayShell struct{ ID, Label string }

type trayItem struct {
	ID      int
	Label   string
	Default bool
	Sep     bool
	Grayed  bool
	Sub     []trayItem
}

// trayMenu: Beth Studio primeiro (negrito), Novo terminal, Sistema, Reiniciar interface e as duas saídas.
func trayMenu(shells []trayShell, hostRunning bool) []trayItem {
	var sub []trayItem
	for i, s := range shells {
		sub = append(sub, trayItem{ID: trayShellBase + i, Label: s.Label})
	}
	if len(sub) == 0 {
		sub = []trayItem{{Label: "(nenhum shell disponível agora)", Grayed: true}}
	}
	items := []trayItem{
		{ID: trayOpen, Label: "Beth Studio", Default: true},
		{Label: "Novo terminal", Sub: sub, Grayed: !hostRunning},
		{ID: trayTasks, Label: "Sistema (CPU, memória, disco)"},
		{ID: trayReload, Label: "Reiniciar interface (terminais continuam)"},
		{Sep: true},
		{ID: trayQuitTray, Label: "Sair da bandeja (terminais continuam)"},
	}
	if hostRunning {
		items = append(items, trayItem{ID: trayKillAll, Label: "Encerrar tudo (fecha os terminais)"})
	}
	return items
}

// trayTooltip: cabe nos 127 caracteres da dica do Windows.
func trayTooltip(panes, waiting int, st hostState) string {
	switch st {
	case hostUnavailable:
		return "Beth Studio — host indisponível"
	case hostStarting:
		return "Beth Studio — iniciando o host…"
	case hostQuitting:
		return "Beth Studio — encerrando"
	}
	t := "Beth Studio"
	switch panes {
	case 0:
		t += " — nenhum terminal"
	case 1:
		t += " — 1 terminal"
	default:
		t += fmt.Sprintf(" — %d terminais", panes)
	}
	if waiting == 1 {
		t += ", 1 agente aguardando você"
	} else if waiting > 1 {
		t += fmt.Sprintf(", %d agentes aguardando você", waiting)
	}
	return t
}

// parseTrayShells lê o evento {"ev":"shells","shells":[{"id","label"}]} da bridge.
func parseTrayShells(raw []byte) []trayShell {
	if len(raw) == 0 {
		return nil
	}
	var ev struct {
		Shells []trayShell `json:"shells"`
	}
	// trayShell sem tags usa os nomes ID/Label; o JSON da bridge é id/label (minúsculo),
	// que o decodificador aceita sem diferenciar maiúsculas.
	if err := json.Unmarshal(raw, &ev); err != nil {
		return nil
	}
	return ev.Shells
}

// trayStats: quantos terminais existem e quantos agentes aguardam.
func (h *hub) trayStats() (panes, waiting int) {
	h.mu.Lock()
	list := h.lastList
	waiting = len(h.agents)
	h.mu.Unlock()
	var ev struct {
		Panes []json.RawMessage `json:"panes"`
	}
	if json.Unmarshal(list, &ev) == nil {
		panes = len(ev.Panes)
	}
	return panes, waiting
}

// trayShellList: os shells que a bridge informou.
func (h *hub) trayShellList() []trayShell {
	h.mu.Lock()
	raw := h.shells
	h.mu.Unlock()
	return parseTrayShells(raw)
}

// spawnShell abre um terminal novo no host (o mesmo caminho do "Novo terminal" da interface).
func (h *hub) spawnShell(shellID string) error {
	if h.readOnly {
		return errors.New("modo somente leitura")
	}
	if !shellIDRe.MatchString(shellID) {
		return fmt.Errorf("shell_id inválido: %q", shellID)
	}
	if h.bridge == nil {
		return errors.New("a ponte com o Beth Studio não está pronta")
	}
	reqID := fmt.Sprintf("tray%d", trayReqSeq.Add(1))
	h.noteSpawn(reqID, shellID)
	return h.bridge.write(map[string]any{"op": "spawn", "shell_id": shellID, "request_id": reqID})
}

var trayReqSeq atomic.Int64
