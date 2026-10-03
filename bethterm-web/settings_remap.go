package main

// settings_remap.go — depois que o Studio recria os terminais num host novo,
// os ids mudaram. Em vez de depender da adoção por título/pasta, o layout, a
// aparência e os nomes por terminal são reescritos pelo mapa antigo→novo.

import (
	"strconv"
	"time"
)

// liveHas: todos estes ids ja' aparecem na ultima lista do host?
func (st *settingsStore) liveHas(ids []int) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	for _, id := range ids {
		if _, ok := st.live[id]; !ok {
			return false
		}
	}
	return true
}

// setFrozen liga/desliga o congelamento do reconcile: durante a restauração
// o host está vazio ou cheio pela metade, e o reconcile normal marcaria tudo
// como encerrado e fecharia as abas.
func (st *settingsStore) setFrozen(on bool) {
	st.mu.Lock()
	st.frozen = on
	st.mu.Unlock()
}

// remapPanes aplica o mapa de ids (antigo→novo) de uma vez: a troca 1↔2 não
// perde nenhum terminal. Folha sem mapeamento vira "encerrada". Entrada de
// aparência/nome sem mapeamento cuja chave colide com um id novo é descartada.
func (st *settingsStore) remapPanes(m map[int]int, newHost string) SettingsSnapshot {
	st.mu.Lock()
	// layout: abas abertas e fechadas
	forEachLeaf(st.s.Layout, func(n *LayoutNode) {
		if n.Gone {
			return
		}
		if nid, ok := m[n.Pane]; ok {
			n.Pane, n.HostID = nid, newHost
			return
		}
		n.Gone = true
	})
	newIDs := map[string]bool{}
	for _, nid := range m {
		newIDs[strconv.Itoa(nid)] = true
	}
	// aparência por terminal
	panes := map[string]*PaneAppearance{}
	for k, p := range st.s.Panes {
		id, err := strconv.Atoi(k)
		if err != nil {
			continue
		}
		if nid, ok := m[id]; ok {
			p.HostID = newHost
			panes[strconv.Itoa(nid)] = p
		}
	}
	for k, p := range st.s.Panes {
		id, _ := strconv.Atoi(k)
		if _, mapped := m[id]; mapped || newIDs[k] {
			continue
		}
		panes[k] = p
	}
	st.s.Panes = panes
	// nomes de aba por terminal
	if st.s.PaneNames != nil {
		names := map[string]*PaneName{}
		for k, n := range st.s.PaneNames {
			id, err := strconv.Atoi(k)
			if err != nil {
				continue
			}
			if nid, ok := m[id]; ok {
				n.HostID, n.GoneSince = newHost, ""
				n.UpdatedAt = time.Now().Format(time.RFC3339)
				names[strconv.Itoa(nid)] = n
			}
		}
		for k, n := range st.s.PaneNames {
			id, _ := strconv.Atoi(k)
			if _, mapped := m[id]; mapped || newIDs[k] {
				continue
			}
			names[k] = n
		}
		st.s.PaneNames = names
	}
	_ = st.saveLocked()
	snap := st.snapshotLocked()
	cb := st.onChg
	st.mu.Unlock()
	if cb != nil {
		cb(snap)
	}
	return snap
}
