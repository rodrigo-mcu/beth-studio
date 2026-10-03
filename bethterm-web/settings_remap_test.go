package main

import (
	"os"
	"path/filepath"
	"testing"
)

func leaf(p int) *LayoutNode { return &LayoutNode{Type: "leaf", Pane: p, Title: "t"} }

func remapTestStore(t *testing.T) *settingsStore {
	t.Helper()
	dir := t.TempDir()
	st := &settingsStore{dir: dir}
	st.s = webSettings{
		Panes: map[string]*PaneAppearance{
			"1": {Appearance: Appearance{Theme: "tema-um"}, HostID: "100@1", Title: "um"},
			"2": {Appearance: Appearance{Theme: "tema-dois"}, HostID: "100@1", Title: "dois"},
		},
		PaneNames: map[string]*PaneName{
			"1": {Name: "Frontend", HostID: "100@1"},
			"2": {Name: "Backend", HostID: "100@1"},
		},
		Layout: &WebLayout{
			Tabs: []LayoutTab{
				{ID: "a", Root: &LayoutNode{Type: "split", Dir: "row", Sizes: []float64{1, 1}, Children: []*LayoutNode{leaf(1), leaf(2)}}},
				{ID: "b", Root: leaf(3)},
			},
			Active: "a",
			Closed: []LayoutTab{{ID: "c", Root: leaf(2)}},
		},
	}
	return st
}

func leavesOf(l *WebLayout) []int {
	var out []int
	forEachLeaf(l, func(n *LayoutNode) {
		if n.Gone {
			out = append(out, -n.Pane) // negativo = encerrado
		} else {
			out = append(out, n.Pane)
		}
	})
	return out
}

func TestRemapPanesRewritesLayoutAppearanceAndNames(t *testing.T) {
	st := remapTestStore(t)
	st.remapPanes(map[int]int{1: 11, 2: 12, 3: 13}, "200@2")
	if got := leavesOf(st.s.Layout); len(got) != 4 || got[0] != 11 || got[1] != 12 || got[2] != 13 || got[3] != 12 {
		t.Fatalf("folhas = %v, quero [11 12 13 12] (a aba fechada também)", got)
	}
	if p := st.s.Panes["11"]; p == nil || p.Theme != "tema-um" || p.HostID != "200@2" {
		t.Fatalf("aparência do 1 não foi para o 11: %+v", st.s.Panes)
	}
	if n := st.s.PaneNames["12"]; n == nil || n.Name != "Backend" || n.HostID != "200@2" {
		t.Fatalf("nome do 2 não foi para o 12: %+v", st.s.PaneNames)
	}
	if _, old := st.s.Panes["1"]; old {
		t.Fatal("a chave antiga 1 não deveria sobrar")
	}
	for _, id := range []int{11, 12, 13} {
		forEachLeaf(st.s.Layout, func(n *LayoutNode) {
			if n.Pane == id && n.HostID != "200@2" {
				t.Fatalf("folha %d sem o host novo: %+v", id, n)
			}
		})
	}
}

func TestRemapPanesSwapDoesNotLoseTerminals(t *testing.T) {
	st := remapTestStore(t)
	st.remapPanes(map[int]int{1: 2, 2: 1}, "200@2")
	got := leavesOf(st.s.Layout)
	if got[0] != 2 || got[1] != 1 {
		t.Fatalf("troca 1<->2: folhas = %v, quero [2 1 ...]", got)
	}
	if st.s.Panes["2"].Theme != "tema-um" || st.s.Panes["1"].Theme != "tema-dois" {
		t.Fatalf("a aparência deveria ter trocado junto: %+v %+v", st.s.Panes["1"], st.s.Panes["2"])
	}
	if st.s.PaneNames["2"].Name != "Frontend" || st.s.PaneNames["1"].Name != "Backend" {
		t.Fatalf("os nomes deveriam ter trocado junto: %+v", st.s.PaneNames)
	}
}

func TestRemapPanesUnmappedLeafBecomesGone(t *testing.T) {
	st := remapTestStore(t)
	st.remapPanes(map[int]int{1: 11, 2: 12}, "200@2") // o 3 não foi recriado
	got := leavesOf(st.s.Layout)
	if got[2] != -3 {
		t.Fatalf("a folha do 3 deveria ficar encerrada (-3): %v", got)
	}
}

func TestRemapPanesDropsUnmappedEntryThatCollidesWithANewID(t *testing.T) {
	st := remapTestStore(t)
	st.s.Panes["5"] = &PaneAppearance{Appearance: Appearance{Theme: "velho"}, HostID: "100@1"}
	st.s.PaneNames["5"] = &PaneName{Name: "Antigo", HostID: "100@1"}
	st.remapPanes(map[int]int{1: 5}, "200@2") // o terminal novo recebeu o id 5
	if p := st.s.Panes["5"]; p == nil || p.Theme != "tema-um" {
		t.Fatalf("o id 5 deve ser do terminal restaurado, não do antigo: %+v", p)
	}
	if n := st.s.PaneNames["5"]; n == nil || n.Name != "Frontend" {
		t.Fatalf("o nome do id 5 deve ser o do terminal restaurado: %+v", n)
	}
}

func TestRemapPanesKeepsUnrelatedEntries(t *testing.T) {
	st := remapTestStore(t)
	st.s.Panes["40"] = &PaneAppearance{Appearance: Appearance{Theme: "outro"}, HostID: "100@1"}
	st.remapPanes(map[int]int{1: 11}, "200@2")
	if p := st.s.Panes["40"]; p == nil || p.Theme != "outro" {
		t.Fatal("entrada sem relação com o mapa não deve sumir")
	}
}

func TestReconcileFrozenKeepsLayoutAndAppearance(t *testing.T) {
	st := remapTestStore(t)
	st.setFrozen(true)
	st.reconcile([]byte(`{"ev":"list","panes":[]}`)) // host novo, vazio
	if len(st.s.Layout.Tabs) != 2 {
		t.Fatalf("congelado: as abas não podem ser fechadas, tem %d", len(st.s.Layout.Tabs))
	}
	forEachLeaf(st.s.Layout, func(n *LayoutNode) {
		if n.Gone {
			t.Fatalf("congelado: nenhuma folha pode virar encerrada: %+v", n)
		}
	})
	if len(st.s.Panes) != 2 || len(st.s.PaneNames) != 2 {
		t.Fatal("congelado: aparência e nomes ficam como estão")
	}
	if len(st.live) != 0 {
		t.Fatal("o reconcile congelado ainda deve atualizar a lista viva")
	}
	st.setFrozen(false)
	st.reconcile([]byte(`{"ev":"list","panes":[]}`))
	if len(st.s.Layout.Tabs) == 2 {
		t.Fatal("descongelado, o reconcile volta ao comportamento normal")
	}
}

func TestSettingsLoadToleratesUTF8BOM(t *testing.T) {
	dir := t.TempDir()
	body := append([]byte{0xEF, 0xBB, 0xBF}, []byte(`{"version":2,"layout":{"v":2,"active":"a","tabs":[{"id":"a","name":"x","root":null}]}}`)...)
	if err := os.WriteFile(filepath.Join(dir, webSettingsFile), body, 0o644); err != nil {
		t.Fatal(err)
	}
	st := &settingsStore{}
	st.load(dir)
	if st.s.Layout == nil || len(st.s.Layout.Tabs) != 1 {
		t.Fatalf("web-settings.json com BOM deveria ser lido (e não descartado como corrompido): %+v", st.s.Layout)
	}
	if matches, _ := filepath.Glob(filepath.Join(dir, "*.corrupt-*")); len(matches) != 0 {
		t.Fatalf("o arquivo não deveria ter sido movido como corrompido: %v", matches)
	}
}
