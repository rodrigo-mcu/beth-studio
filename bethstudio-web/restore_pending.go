package main

// restore_pending.go — terminais WSL que a restauração não abriu porque a
// pasta deles não existe (o disco ainda não foi montado). Ficam numa lista
// (pendingSet) que:
//   - entra na receita (pane-specs.json), para um host que cair não os perder;
//   - vira a lista do banner, com as ações do usuário (continuar tentando,
//     guardar, abrir na pasta padrão, descartar);
//   - é reconferida sozinha por um tempo (retryAll).
// Quando um deles abre, a folha encerrada que ele tinha no layout é revivida
// (settings.reviveLeaf): o terminal volta como "Aba fechada “nome”" na grade e
// clicar nele reabre a aba com o nome e os vizinhos de antes.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// pendingIDBase desloca o id dos pendentes na receita: o host de hoje já
// reaproveitou os números baixos, e dois specs com o mesmo id se confundiriam
// na próxima restauração.
const pendingIDBase = 1_000_000

type pendingSet struct {
	mu    sync.Mutex
	items []restorePending
}

func (ps *pendingSet) set(items []restorePending) {
	ps.mu.Lock()
	ps.items = append([]restorePending(nil), items...)
	ps.mu.Unlock()
}

func (ps *pendingSet) list() []restorePending {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	return append([]restorePending(nil), ps.items...)
}

func (ps *pendingSet) find(paneID int) (restorePending, bool) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	for _, p := range ps.items {
		if p.PaneID == paneID {
			return p, true
		}
	}
	return restorePending{}, false
}

func (ps *pendingSet) take(paneID int) (restorePending, bool) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	for i, p := range ps.items {
		if p.PaneID == paneID {
			ps.items = append(ps.items[:i:i], ps.items[i+1:]...)
			return p, true
		}
	}
	return restorePending{}, false
}

func (ps *pendingSet) setKeep(paneID int, keep bool) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	for i := range ps.items {
		if ps.items[i].PaneID == paneID {
			ps.items[i].Keep = keep
		}
	}
}

// recipeSpecs: os specs dos pendentes para a receita, com id deslocado e a
// ordem continuando a dos terminais vivos (start).
func (ps *pendingSet) recipeSpecs(start int) []paneSpec {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	out := make([]paneSpec, 0, len(ps.items))
	for i, p := range ps.items {
		s := p.Spec
		if s.PaneID < pendingIDBase {
			s.PaneID = pendingIDBase + p.PaneID
		}
		s.OrigPane, s.OrigHost, s.OrigName, s.OrigLook = p.PaneID, p.OldHost, p.Name, p.Look
		s.Order = start + i
		out = append(out, s)
	}
	return out
}

// pendingDeps: o que as ações precisam do mundo de fora (trocado nos testes).
type pendingDeps struct {
	dirExists  func(ctx context.Context, distro, path string) bool
	open       func(ctx context.Context, s paneSpec, cwd string) (newPane int, err error)
	revive     func(p restorePending, newPane int) // devolve a folha ao layout
	discard    func(p restorePending)              // tira a folha encerrada do layout
	defaultDir func(distro string) string
	publish    func(list []restorePending) // avisa a interface
}

// useOrigin: um pendente que veio de uma receita com id deslocado (segundo
// reinício) volta a ser o terminal original: o id e o host da folha encerrada
// no layout, o nome de aba e a aparência.
func (p *restorePending) useOrigin() {
	if p.Spec.OrigHost == "" {
		return
	}
	p.PaneID, p.OldHost = p.Spec.OrigPane, p.Spec.OrigHost
	p.Name, p.Look = p.Spec.OrigName, p.Spec.OrigLook
}

// add devolve um pendente à lista (abrir falhou).
func (ps *pendingSet) add(p restorePending) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	for _, x := range ps.items {
		if x.PaneID == p.PaneID {
			return
		}
	}
	ps.items = append(ps.items, p)
}

// openPending abre o terminal pendente (cwd "" = home), revive a folha e o tira
// da lista. O pendente é reivindicado ANTES de abrir: "Continuar tentando", um
// duplo clique e a retentativa automática ao mesmo tempo abrem um terminal só.
func (ps *pendingSet) openPending(ctx context.Context, d pendingDeps, p restorePending, cwd string) (bool, error) {
	if _, ok := ps.take(p.PaneID); !ok {
		return false, nil // outro já está abrindo (ou foi descartado)
	}
	newPane, err := d.open(ctx, p.Spec, cwd)
	if err != nil {
		ps.add(p)
		return false, err
	}
	d.revive(p, newPane)
	d.publish(ps.list())
	return true, nil
}

// act aplica uma ação do usuário. found=false: não há pendente com esse id.
func (ps *pendingSet) act(ctx context.Context, d pendingDeps, paneID int, action string) (found, opened bool, err error) {
	p, ok := ps.find(paneID)
	if !ok {
		return false, false, nil
	}
	switch action {
	case "retry": // "Continuar tentando": também tira o terminal do repouso
		ps.setKeep(paneID, false)
		p.Keep = false
		if !d.dirExists(ctx, p.Distro, p.Cwd) {
			d.publish(ps.list())
			return true, false, nil
		}
		opened, err = ps.openPending(ctx, d, p, p.Cwd)
		return true, opened, err
	case "default": // "Abrir na pasta padrão": a da configuração, ou a home (nunca "/")
		dir := d.defaultDir(p.Distro)
		if dir != "" && !d.dirExists(ctx, p.Distro, dir) {
			dir = ""
		}
		opened, err = ps.openPending(ctx, d, p, dir)
		return true, opened, err
	case "keep": // "Guardar": para de tentar sozinho
		ps.setKeep(paneID, true)
		d.publish(ps.list())
		return true, false, nil
	case "discard": // única ação que apaga a receita e a folha
		ps.take(paneID)
		d.discard(p)
		d.publish(ps.list())
		return true, false, nil
	}
	return true, false, fmt.Errorf("ação inválida: %q", action)
}

// retryAll reconfere os pendentes que não estão guardados e abre os que ganharam pasta.
func (ps *pendingSet) retryAll(ctx context.Context, d pendingDeps) (opened int) {
	for _, p := range ps.list() {
		if ctx.Err() != nil {
			break
		}
		if p.Keep || !d.dirExists(ctx, p.Distro, p.Cwd) {
			continue
		}
		if ok, err := ps.openPending(ctx, d, p, p.Cwd); err == nil && ok {
			opened++
		}
	}
	return opened
}

// --- layout: reviver e descartar a folha encerrada ---

// reviveLeaf devolve a folha encerrada do terminal pendente (id antigo, host
// antigo) a um terminal vivo. Só a folha encerrada do host antigo é tocada: um
// terminal vivo que hoje reaproveita o mesmo número nunca é confundido com ela.
// O grupo de abas fechadas que a contém deixa de contar como "tudo encerrado".
func (st *settingsStore) reviveLeaf(oldPane, newPane int, oldHost, newHost string) bool {
	found := false
	_, _ = st.mutate(func() error {
		if st.s.Layout == nil {
			return nil
		}
		forEachLeaf(st.s.Layout, func(n *LayoutNode) {
			if !found && n.Gone && n.Pane == oldPane && n.HostID == oldHost {
				n.Pane, n.HostID, n.Gone = newPane, newHost, false
				found = true
			}
		})
		if !found {
			return nil
		}
		for i := range st.s.Layout.Closed {
			alive := false
			forEachLeafOf(st.s.Layout.Closed[i].Root, func(n *LayoutNode) {
				if !n.Gone {
					alive = true
				}
			})
			if alive {
				st.s.Layout.Closed[i].GoneSince = ""
			}
		}
		return st.saveLocked()
	})
	return found
}

// removeGoneLeaf tira do layout a folha encerrada (id antigo, host antigo): o
// "Descartar" de um pendente. O grupo fechado que fica sem folhas some.
func (st *settingsStore) removeGoneLeaf(oldPane int, oldHost string) bool {
	removed := false
	match := func(n *LayoutNode) bool {
		if n.Gone && n.Pane == oldPane && n.HostID == oldHost {
			removed = true
			return true
		}
		return false
	}
	_, _ = st.mutate(func() error {
		l := st.s.Layout
		if l == nil {
			return nil
		}
		for i := range l.Tabs {
			l.Tabs[i].Root, _ = pruneLeaf(l.Tabs[i].Root, match)
		}
		kept := l.Closed[:0:0]
		for _, c := range l.Closed {
			c.Root, _ = pruneLeaf(c.Root, match)
			if c.Root != nil {
				kept = append(kept, c)
			}
		}
		l.Closed = kept
		if !removed {
			return nil
		}
		return st.saveLocked()
	})
	return removed
}

// forEachLeafOf percorre as folhas de uma árvore.
func forEachLeafOf(n *LayoutNode, f func(n *LayoutNode)) {
	if n == nil {
		return
	}
	if n.Type == "leaf" {
		f(n)
		return
	}
	for _, c := range n.Children {
		forEachLeafOf(c, f)
	}
}

// pendingRetryState: a retentativa automática (uma só rodando; cada "Continuar
// tentando" renova a janela de 5 minutos).
type pendingRetryState struct {
	running atomic.Bool
	until   atomic.Int64 // unix nano
	kick    func()       // produção: liga a retentativa; nil nos testes
}

const (
	pendingRetryEvery  = 15 * time.Second
	pendingRetryWindow = 5 * time.Minute
)

// restorePendingHandler: POST /api/restore/pending {"pane_id","action":"retry"|"default"|"keep"|"discard"}.
func restorePendingHandler(h *hub, readOnly bool, deps func() pendingDeps) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
			return
		}
		if readOnly {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "modo somente leitura"})
			return
		}
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			http.Error(w, "use application/json", http.StatusUnsupportedMediaType)
			return
		}
		var req struct {
			PaneID *int   `json:"pane_id"`
			Action string `json:"action"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil || req.PaneID == nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
			return
		}
		switch req.Action {
		case "retry", "default", "keep", "discard":
		default:
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "ação inválida"})
			return
		}
		if h.restore == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "não há terminais pendentes"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
		defer cancel()
		found, opened, err := h.restore.holds.act(ctx, deps(), *req.PaneID, req.Action)
		switch {
		case !found:
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "esse terminal não está pendente"})
		case err != nil:
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		default:
			if req.Action == "retry" && !opened && h.pendingRetry.kick != nil {
				h.pendingRetry.kick() // "Continuar tentando": a retentativa automática recomeça
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "opened": opened})
		}
	})
}

// parkPending guarda a folha encerrada de cada pendente num grupo de abas
// fechadas. O Go apaga a folha encerrada das abas abertas (dropEndedOpenTabs);
// no grupo fechado ela sobrevive até o terminal abrir (reviveLeaf) e então
// aparece na grade como "Aba fechada “nome”". Chamar logo depois do remap.
func (st *settingsStore) parkPending(items []restorePending) {
	_, _ = st.mutate(func() error {
		l := st.s.Layout
		if l == nil {
			return nil
		}
		isIt := func(n *LayoutNode, p restorePending) bool {
			return n.Gone && n.Pane == p.PaneID && n.HostID == p.OldHost
		}
		changed := false
		for _, p := range items {
			inClosed := false
			for _, c := range l.Closed {
				forEachLeafOf(c.Root, func(n *LayoutNode) { inClosed = inClosed || isIt(n, p) })
			}
			if inClosed {
				continue
			}
			g := LayoutTab{
				ID:       fmt.Sprintf("pend%d-%d", p.PaneID, time.Now().UnixNano()%1000000),
				Root:     &LayoutNode{Type: "leaf", Pane: p.PaneID, Gone: true, Title: p.Title, Cwd: p.Cwd, HostID: p.OldHost},
				ClosedAt: time.Now().UTC().Format(time.RFC3339),
			}
			for _, t := range l.Tabs { // a folha que estava numa aba aberta dá o nome da aba e o título/pasta de antes
				forEachLeafOf(t.Root, func(n *LayoutNode) {
					if isIt(n, p) {
						g.Name = t.Name
						g.Root.Title, g.Root.Cwd = n.Title, n.Cwd
					}
				})
			}
			l.Closed = append([]LayoutTab{g}, l.Closed...)
			if len(l.Closed) > maxClosed {
				l.Closed = l.Closed[:maxClosed]
			}
			changed = true
		}
		if !changed {
			return nil
		}
		return st.saveLocked()
	})
}
