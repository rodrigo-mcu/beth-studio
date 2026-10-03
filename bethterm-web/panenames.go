package main

// panenames.go — nome de aba dado pelo usuario, guardado POR PANE, para a
// aba nova de um terminal reaberto nascer com esse nome (renomear a aba,
// fechar, clicar no terminal de novo => mesmo nome).
//
// Mesma identidade de pane da aparencia por pane: id + host (host.pid) e,
// depois de reiniciar o host, adocao pelo titulo ou pela pasta. Nome de
// pane encerrado some depois de 14 dias encerrado (GoneSince).

import (
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type PaneName struct {
	Name      string `json:"name"`
	Title     string `json:"title,omitempty"`
	Cwd       string `json:"cwd,omitempty"`
	HostID    string `json:"host_id,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`
	// GoneSince: desde quando o pane nao aparece (vazio = vivo).
	GoneSince string `json:"gone_since,omitempty"`
}

const paneNameMaxLen = 60
const paneNameKeep = 14 * 24 * time.Hour

// setPaneNames grava (ou, com nome vazio, apaga) o nome de cada pane.
// Panes fora da lista do host sao ignorados na gravacao (apagar vale sempre).
func (st *settingsStore) setPaneNames(ids []int, name string) (SettingsSnapshot, error) {
	name = strings.TrimSpace(name)
	if utf8.RuneCountInString(name) > paneNameMaxLen {
		name = string([]rune(name)[:paneNameMaxLen])
	}
	if len(ids) == 0 || len(ids) > 24 {
		return SettingsSnapshot{}, errors.New("lista de terminais inválida")
	}
	return st.mutate(func() error {
		if st.s.PaneNames == nil {
			st.s.PaneNames = map[string]*PaneName{}
		}
		now := time.Now().Format(time.RFC3339)
		for _, id := range ids {
			if id < 0 {
				continue
			}
			key := strconv.Itoa(id)
			if name == "" {
				delete(st.s.PaneNames, key)
				continue
			}
			m, ok := st.live[id]
			if !ok {
				continue
			}
			st.s.PaneNames[key] = &PaneName{Name: name, Title: m.title, Cwd: m.cwd, HostID: st.hostID(), UpdatedAt: now}
		}
		return st.saveLocked()
	})
}

// reconcilePaneNamesLocked: na lista nova do host, atualiza titulo/pasta,
// adota nomes do host anterior e marca/apaga os encerrados. Devolve true
// quando algo estrutural mudou (precisa gravar).
func (st *settingsStore) reconcilePaneNamesLocked(host string, now time.Time) bool {
	changed := false
	for k, n := range st.s.PaneNames {
		id, err := strconv.Atoi(k)
		if err != nil || n == nil || n.Name == "" {
			delete(st.s.PaneNames, k)
			changed = true
			continue
		}
		m, alive := st.live[id]
		switch {
		case alive && n.HostID == host: // (sem host.pid, host == "": confia no id)
			if n.Title != m.title || n.Cwd != m.cwd {
				n.Title, n.Cwd = m.title, m.cwd
				st.dirty = true
			}
			if n.GoneSince != "" {
				n.GoneSince = ""
				changed = true
			}
		case alive && n.HostID != host && ((n.Cwd != "" && n.Cwd == m.cwd) || (n.Title != "" && n.Title == m.title)):
			n.HostID, n.Title, n.Cwd, n.GoneSince = host, m.title, m.cwd, ""
			changed = true
		default:
			if n.GoneSince == "" {
				n.GoneSince = now.Format(time.RFC3339)
				changed = true
			} else if t, err := time.Parse(time.RFC3339, n.GoneSince); err != nil || now.Sub(t) > paneNameKeep {
				delete(st.s.PaneNames, k)
				changed = true
			}
		}
	}
	return changed
}

// paneNamesViewLocked: so' os nomes validos para o host atual.
func (st *settingsStore) paneNamesViewLocked(host string) map[string]string {
	out := map[string]string{}
	for k, n := range st.s.PaneNames {
		if n == nil || n.Name == "" {
			continue
		}
		if n.HostID == host {
			out[k] = n.Name
			continue
		}
		id, err := strconv.Atoi(k)
		if err != nil {
			continue
		}
		if m, ok := st.live[id]; ok && ((n.Cwd != "" && n.Cwd == m.cwd) || (n.Title != "" && n.Title == m.title)) {
			out[k] = n.Name
		}
	}
	return out
}
