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

// remapBase: copia da aparencia e dos nomes por terminal tirada ANTES de recriar os terminais.
// Os ids reiniciam do zero a cada host, e abrir o terminal novo de id 1 faz recordSpawn apagar a
// aparencia do terminal antigo que tambem era "1": o remapeamento parte da copia, nao do estado vivo.
type remapBase struct {
	panes map[string]*PaneAppearance
	names map[string]*PaneName
}

func (st *settingsStore) captureRemapBase() *remapBase {
	st.mu.Lock()
	defer st.mu.Unlock()
	b := &remapBase{panes: map[string]*PaneAppearance{}, names: map[string]*PaneName{}}
	for k, p := range st.s.Panes {
		c := *p
		b.panes[k] = &c
	}
	for k, n := range st.s.PaneNames {
		c := *n
		b.names[k] = &c
	}
	return b
}

// remapPanes aplica o mapa de ids (antigo->novo) de uma vez a partir do estado atual.
func (st *settingsStore) remapPanes(m map[int]int, newHost string) SettingsSnapshot {
	return st.remapPanesFrom(nil, m, newHost)
}

// remapPanesFrom aplica o mapa de ids de uma vez: a troca 1<->2 nao perde nenhum terminal.
// Folha sem mapeamento vira "encerrada". Entrada de aparencia/nome sem mapeamento cuja chave
// colide com um id novo e' descartada. base (se houver) e' a copia anterior a restauracao.
func (st *settingsStore) remapPanesFrom(base *remapBase, m map[int]int, newHost string) SettingsSnapshot {
	st.mu.Lock()
	if base == nil {
		base = &remapBase{panes: st.s.Panes, names: st.s.PaneNames}
	}
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
	// aparencia por terminal
	panes := map[string]*PaneAppearance{}
	for k, p := range base.panes {
		id, err := strconv.Atoi(k)
		if err != nil {
			continue
		}
		if nid, ok := m[id]; ok {
			p.HostID = newHost
			panes[strconv.Itoa(nid)] = p
		}
	}
	for k, p := range base.panes {
		id, _ := strconv.Atoi(k)
		if _, mapped := m[id]; mapped || newIDs[k] {
			continue
		}
		panes[k] = p
	}
	st.s.Panes = panes
	// nomes de aba por terminal
	if base.names != nil || st.s.PaneNames != nil {
		names := map[string]*PaneName{}
		for k, n := range base.names {
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
		for k, n := range base.names {
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

// adoptIdentity dá ao terminal novo o nome de aba e a aparência que o terminal
// pendente tinha (o id antigo se perdeu na restauração).
func (st *settingsStore) adoptIdentity(newPane int, name *PaneName, look *PaneAppearance, host string) {
	if name == nil && look == nil {
		return
	}
	_, _ = st.mutate(func() error {
		key := strconv.Itoa(newPane)
		if name != nil {
			c := *name
			c.HostID = host
			if st.s.PaneNames == nil {
				st.s.PaneNames = map[string]*PaneName{}
			}
			st.s.PaneNames[key] = &c
		}
		if look != nil {
			c := *look
			c.HostID = host
			if st.s.Panes == nil {
				st.s.Panes = map[string]*PaneAppearance{}
			}
			st.s.Panes[key] = &c
		}
		return st.saveLocked()
	})
}
