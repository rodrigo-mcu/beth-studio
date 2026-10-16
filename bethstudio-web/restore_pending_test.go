package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func pendingFixture() []restorePending {
	return []restorePending{
		{PaneID: 3, Title: "arte-maior", Distro: "Debian", Cwd: "/mnt/kingston/mcu/repo/a", OldHost: "100@1",
			Spec: paneSpec{PaneID: 3, Kind: "wsl", ShellID: "wsl.default", Distro: "Debian", Cwd: "/mnt/kingston/mcu/repo/a", Title: "arte-maior"}},
		{PaneID: 4, Title: "sistema escola", Distro: "Debian", Cwd: "/mnt/kingston/mcu/repo/b", OldHost: "100@1",
			Spec: paneSpec{PaneID: 4, Kind: "wsl", ShellID: "wsl.default", Distro: "Debian", Cwd: "/mnt/kingston/mcu/repo/b", Title: "sistema escola"}},
	}
}

func TestPendingRecipeSpecsHaveUniqueIDs(t *testing.T) {
	var ps pendingSet
	ps.set(pendingFixture())
	specs := ps.recipeSpecs(10)
	if len(specs) != 2 || specs[0].PaneID != pendingIDBase+3 || specs[1].PaneID != pendingIDBase+4 {
		t.Fatalf("specs = %+v", specs)
	}
	if specs[0].Order != 10 || specs[1].Order != 11 {
		t.Fatalf("a ordem continua depois dos vivos: %+v", specs)
	}
	// um spec que já veio de uma receita com id deslocado não é deslocado de novo
	ps.set([]restorePending{{PaneID: pendingIDBase + 3, Spec: paneSpec{PaneID: pendingIDBase + 3, Kind: "wsl"}}})
	if got := ps.recipeSpecs(0); got[0].PaneID != pendingIDBase+3 {
		t.Fatalf("id deslocado duas vezes: %+v", got)
	}
}

func TestFlushKeepsPendingSpecsInTheRecipe(t *testing.T) {
	h := newCoordHarness()
	h.built = []paneSpec{{PaneID: 1, ShellID: "cmd", Kind: "cmd", Cwd: `C:\a`}}
	c := newTestCoordinator(h)
	c.holds.set(pendingFixture())
	c.onList([]byte(listTwo))
	c.waitIdle()
	if len(h.saved) != 1 {
		t.Fatalf("gravações = %d", len(h.saved))
	}
	got := h.saved[0].Specs
	if len(got) != 3 || got[1].PaneID != pendingIDBase+3 || got[1].Cwd != "/mnt/kingston/mcu/repo/a" {
		t.Fatalf("a receita perdeu os pendentes: %+v", got)
	}
	// a lista viva vazia de um host que já restaurou também não apaga os pendentes
	h2 := newCoordHarness()
	h2.built = nil
	c2 := newTestCoordinator(h2)
	c2.holds.set(pendingFixture())
	c2.onList([]byte(listEmpty))
	c2.waitIdle()
	if len(h2.saved) == 0 || len(h2.saved[len(h2.saved)-1].Specs) != 2 {
		t.Fatalf("receita só com os pendentes: %+v", h2.saved)
	}
}

func pendingLayoutStore(t *testing.T) *settingsStore {
	t.Helper()
	st := &settingsStore{dir: t.TempDir()}
	st.s = webSettings{Layout: &WebLayout{
		Tabs: []LayoutTab{
			// outro terminal, de outro host, que hoje reaproveita o id 3
			{ID: "t1", Root: &LayoutNode{Type: "leaf", Pane: 3, Title: "outro", HostID: "200@2"}},
		},
		Active: "t1",
		Closed: []LayoutTab{{
			ID: "c1", Name: "arte-maior", GoneSince: "2026-10-16T14:00:00-03:00",
			Root: &LayoutNode{Type: "leaf", Pane: 3, Gone: true, Title: "arte-maior", HostID: "100@1"},
		}},
	}}
	return st
}

func TestRemapKeepsPendingAsGoneLeaf(t *testing.T) {
	st := pendingLayoutStore(t)
	st.s.Layout.Tabs = append(st.s.Layout.Tabs, LayoutTab{ID: "t2", Root: &LayoutNode{Type: "leaf", Pane: 3, Title: "arte-maior", HostID: "100@1"}})
	st.remapPanes(map[int]int{}, "200@2") // o terminal 3 não foi recriado (pendente)
	var gone *LayoutNode
	for _, tb := range st.s.Layout.Tabs {
		if tb.ID == "t2" {
			gone = tb.Root
		}
	}
	if gone == nil || !gone.Gone || gone.Title != "arte-maior" || gone.HostID != "100@1" {
		t.Fatalf("o pendente deveria virar folha encerrada com título e host antigos: %+v", gone)
	}
}

func TestReviveLeafOnlyRevivesTheGoneOne(t *testing.T) {
	st := pendingLayoutStore(t)
	if !st.reviveLeaf(3, 8, "100@1", "200@2") {
		t.Fatal("a folha encerrada do host antigo deveria ser revivida")
	}
	l := st.s.Layout
	if live := l.Tabs[0].Root; live.Pane != 3 || live.Gone || live.HostID != "200@2" || live.Title != "outro" {
		t.Fatalf("a folha viva de mesmo id foi tocada: %+v", live)
	}
	g := l.Closed[0]
	if g.Root.Pane != 8 || g.Root.Gone || g.Root.HostID != "200@2" || g.GoneSince != "" {
		t.Fatalf("grupo fechado = %+v raiz = %+v", g, g.Root)
	}
	if st.reviveLeaf(3, 9, "100@1", "200@2") {
		t.Fatal("não há mais folha encerrada do host antigo com esse id")
	}
	if st.reviveLeaf(3, 9, "999@9", "200@2") {
		t.Fatal("host antigo diferente não casa")
	}
}

func TestRemoveGoneLeafDropsTheClosedGroup(t *testing.T) {
	st := pendingLayoutStore(t)
	if !st.removeGoneLeaf(3, "100@1") {
		t.Fatal("deveria remover a folha encerrada")
	}
	if len(st.s.Layout.Closed) != 0 {
		t.Fatalf("o grupo fechado ficou vazio e deveria sumir: %+v", st.s.Layout.Closed)
	}
	if st.s.Layout.Tabs[0].Root == nil || st.s.Layout.Tabs[0].Root.Pane != 3 {
		t.Fatal("a folha viva de mesmo id não pode ser removida")
	}
	if st.removeGoneLeaf(3, "100@1") {
		t.Fatal("já removida")
	}
}

type pendingHarness struct {
	dirs      map[string]bool // "distro|path"
	opened    []paneSpec
	cwds      []string
	openErr   error
	revived   []int
	discards  []int
	published int
	defDir    string
	next      int
}

func newPendingHarness() *pendingHarness { return &pendingHarness{dirs: map[string]bool{}, next: 200} }

func (h *pendingHarness) deps() pendingDeps {
	return pendingDeps{
		dirExists: func(_ context.Context, d, p string) bool { return h.dirs[d+"|"+p] },
		open: func(_ context.Context, s paneSpec, cwd string) (int, error) {
			if h.openErr != nil {
				return 0, h.openErr
			}
			h.opened = append(h.opened, s)
			h.cwds = append(h.cwds, cwd)
			h.next++
			return h.next, nil
		},
		revive:     func(p restorePending, newPane int) { h.revived = append(h.revived, p.PaneID*1000+newPane) },
		discard:    func(p restorePending) { h.discards = append(h.discards, p.PaneID) },
		defaultDir: func(string) string { return h.defDir },
		publish:    func([]restorePending) { h.published++ },
	}
}

func TestPendingRetryOpensWhenDirAppears(t *testing.T) {
	h, ps := newPendingHarness(), &pendingSet{}
	ps.set(pendingFixture())
	ctx := context.Background()
	found, opened, err := ps.act(ctx, h.deps(), 3, "retry")
	if err != nil || !found || opened || len(h.opened) != 0 {
		t.Fatalf("pasta ainda ausente: found=%v opened=%v err=%v", found, opened, err)
	}
	if len(ps.list()) != 2 {
		t.Fatal("continua pendente")
	}
	h.dirs["Debian|/mnt/kingston/mcu/repo/a"] = true
	found, opened, err = ps.act(ctx, h.deps(), 3, "retry")
	if err != nil || !found || !opened {
		t.Fatalf("found=%v opened=%v err=%v", found, opened, err)
	}
	if len(h.opened) != 1 || h.cwds[0] != "/mnt/kingston/mcu/repo/a" || len(h.revived) != 1 || h.revived[0] != 3*1000+201 {
		t.Fatalf("opened=%v cwds=%v revived=%v", h.opened, h.cwds, h.revived)
	}
	if l := ps.list(); len(l) != 1 || l[0].PaneID != 4 {
		t.Fatalf("restou só o 4: %+v", l)
	}
}

func TestPendingKeepStopsAutoRetryButRetryResumesIt(t *testing.T) {
	h, ps := newPendingHarness(), &pendingSet{}
	ps.set(pendingFixture())
	h.dirs["Debian|/mnt/kingston/mcu/repo/a"], h.dirs["Debian|/mnt/kingston/mcu/repo/b"] = true, true
	ctx := context.Background()
	if found, _, _ := ps.act(ctx, h.deps(), 3, "keep"); !found {
		t.Fatal("keep deveria achar o pendente")
	}
	if n := ps.retryAll(ctx, h.deps()); n != 1 {
		t.Fatalf("a retentativa automática abre só o que não foi guardado: %d", n)
	}
	if l := ps.list(); len(l) != 1 || l[0].PaneID != 3 || !l[0].Keep {
		t.Fatalf("o guardado continua pendente: %+v", l)
	}
	// "Continuar tentando" tira o guardado do repouso
	if _, opened, _ := ps.act(ctx, h.deps(), 3, "retry"); !opened {
		t.Fatal("retry abre quando a pasta existe")
	}
}

func TestPendingDefaultOpensInDefaultDir(t *testing.T) {
	h, ps := newPendingHarness(), &pendingSet{}
	ps.set(pendingFixture())
	h.defDir = "/home/dev"
	h.dirs["Debian|/home/dev"] = true
	_, opened, err := ps.act(context.Background(), h.deps(), 3, "default")
	if err != nil || !opened || h.cwds[0] != "/home/dev" {
		t.Fatalf("opened=%v err=%v cwds=%v", opened, err, h.cwds)
	}
	// pasta padrão que também não existe: cai na home (cwd vazio), nunca em "/"
	h.defDir = "/mnt/nao/existe"
	_, opened, _ = ps.act(context.Background(), h.deps(), 4, "default")
	if !opened || h.cwds[1] != "" {
		t.Fatalf("cwds = %v", h.cwds)
	}
}

func TestPendingDiscardRemovesRecipeAndLeaf(t *testing.T) {
	h, ps := newPendingHarness(), &pendingSet{}
	ps.set(pendingFixture())
	found, _, _ := ps.act(context.Background(), h.deps(), 3, "discard")
	if !found || len(h.discards) != 1 || h.discards[0] != 3 {
		t.Fatalf("found=%v discards=%v", found, h.discards)
	}
	if specs := ps.recipeSpecs(0); len(specs) != 1 || specs[0].PaneID != pendingIDBase+4 {
		t.Fatalf("a receita não deve mais ter o 3: %+v", specs)
	}
	if h.published == 0 {
		t.Fatal("a interface deveria ser avisada")
	}
}

func TestPendingOpenFailureStaysPending(t *testing.T) {
	h, ps := newPendingHarness(), &pendingSet{}
	ps.set(pendingFixture())
	h.dirs["Debian|/mnt/kingston/mcu/repo/a"] = true
	h.openErr = errors.New("o host não respondeu")
	_, opened, err := ps.act(context.Background(), h.deps(), 3, "retry")
	if err == nil || opened || len(ps.list()) != 2 {
		t.Fatalf("opened=%v err=%v list=%+v", opened, err, ps.list())
	}
}

func TestPendingActUnknownPaneAndAction(t *testing.T) {
	h, ps := newPendingHarness(), &pendingSet{}
	ps.set(pendingFixture())
	if found, _, _ := ps.act(context.Background(), h.deps(), 99, "retry"); found {
		t.Fatal("id desconhecido não é encontrado")
	}
	if _, _, err := ps.act(context.Background(), h.deps(), 3, "dançar"); err == nil {
		t.Fatal("ação desconhecida deveria dar erro")
	}
}

func TestPendingConcurrentRetryOpensOnce(t *testing.T) {
	h, ps := newPendingHarness(), &pendingSet{}
	ps.set(pendingFixture()[:1])
	h.dirs["Debian|/mnt/kingston/mcu/repo/a"] = true
	release := make(chan struct{})
	entered := make(chan struct{}, 4)
	var mu sync.Mutex
	opens := 0
	d := h.deps()
	d.open = func(context.Context, paneSpec, string) (int, error) {
		mu.Lock()
		opens++
		mu.Unlock()
		entered <- struct{}{}
		<-release
		return 300, nil
	}
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, _, _ = ps.act(context.Background(), d, 3, "retry") }()
	}
	<-entered                         // um dos dois está abrindo
	time.Sleep(60 * time.Millisecond) // dá tempo ao outro de tentar abrir também
	close(release)
	wg.Wait()
	if opens != 1 {
		t.Fatalf("o terminal abriu %d vezes, quero 1", opens)
	}
}

func TestPendingRetryAllAndActDoNotDoubleOpen(t *testing.T) {
	h, ps := newPendingHarness(), &pendingSet{}
	ps.set(pendingFixture()[:1])
	h.dirs["Debian|/mnt/kingston/mcu/repo/a"] = true
	release := make(chan struct{})
	entered := make(chan struct{}, 4)
	var mu sync.Mutex
	opens := 0
	d := h.deps()
	d.open = func(context.Context, paneSpec, string) (int, error) {
		mu.Lock()
		opens++
		mu.Unlock()
		entered <- struct{}{}
		<-release
		return 300, nil
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); ps.retryAll(context.Background(), d) }()
	go func() { defer wg.Done(); _, _, _ = ps.act(context.Background(), d, 3, "default") }()
	<-entered
	time.Sleep(60 * time.Millisecond)
	close(release)
	wg.Wait()
	if opens != 1 {
		t.Fatalf("o terminal abriu %d vezes, quero 1", opens)
	}
}

func TestRecipeSpecsKeepTheOriginalIdentity(t *testing.T) {
	var ps pendingSet
	p := pendingFixture()[0]
	p.Name = &PaneName{Name: "arte-maior"}
	p.Look = &PaneAppearance{Title: "x"}
	ps.set([]restorePending{p})
	s := ps.recipeSpecs(0)[0]
	if s.OrigPane != 3 || s.OrigHost != "100@1" || s.OrigName == nil || s.OrigName.Name != "arte-maior" || s.OrigLook == nil {
		t.Fatalf("a receita precisa guardar quem o terminal era: %+v", s)
	}
}

func TestUseOriginRestoresTheLinkOfASecondGeneration(t *testing.T) {
	spec := paneSpec{PaneID: pendingIDBase + 3, Kind: "wsl", OrigPane: 3, OrigHost: "100@1", OrigName: &PaneName{Name: "arte-maior"}, OrigLook: &PaneAppearance{Title: "x"}}
	p := restorePending{PaneID: pendingIDBase + 3, OldHost: "200@2", Spec: spec}
	p.useOrigin()
	if p.PaneID != 3 || p.OldHost != "100@1" || p.Name == nil || p.Name.Name != "arte-maior" || p.Look == nil {
		t.Fatalf("pendente de segunda geração = %+v", p)
	}
	q := restorePending{PaneID: 3, OldHost: "100@1", Spec: paneSpec{PaneID: 3}}
	q.useOrigin()
	if q.PaneID != 3 || q.OldHost != "100@1" || q.Name != nil {
		t.Fatalf("primeira geração não muda: %+v", q)
	}
}

func TestParkPendingMovesTheOpenLeafToAClosedGroup(t *testing.T) {
	st := &settingsStore{dir: t.TempDir()}
	st.s = webSettings{Layout: &WebLayout{
		Tabs:   []LayoutTab{{ID: "t2", Name: "arte-maior", Root: &LayoutNode{Type: "leaf", Pane: 3, Title: "arte-maior", HostID: "100@1"}}},
		Active: "t2",
	}}
	st.remapPanes(map[int]int{}, "200@2") // a restauração não recriou o 3: a folha vira encerrada
	st.parkPending([]restorePending{{PaneID: 3, OldHost: "100@1", Title: "arte-maior"}})
	// o reconcile descongela, apaga a folha encerrada da aba aberta e grava
	_, _ = st.mutate(func() error { dropEndedOpenTabs(st.s.Layout); return st.saveLocked() })
	l := st.s.Layout
	if len(l.Closed) != 1 || l.Closed[0].Name != "arte-maior" || l.Closed[0].Root == nil || !l.Closed[0].Root.Gone {
		t.Fatalf("a folha deveria estar guardada num grupo fechado: %+v", l.Closed)
	}
	if !tabIDRe.MatchString(l.Closed[0].ID) {
		t.Fatalf("id de aba inválido: %q", l.Closed[0].ID)
	}
	st.parkPending([]restorePending{{PaneID: 3, OldHost: "100@1", Title: "arte-maior"}})
	if len(st.s.Layout.Closed) != 1 {
		t.Fatalf("guardar duas vezes não pode duplicar o grupo: %d", len(st.s.Layout.Closed))
	}
	if !st.reviveLeaf(3, 8, "100@1", "200@2") {
		t.Fatal("depois de guardada, a folha precisa poder ser revivida")
	}
	if r := st.s.Layout.Closed[0].Root; r.Pane != 8 || r.Gone {
		t.Fatalf("raiz = %+v", r)
	}
}
