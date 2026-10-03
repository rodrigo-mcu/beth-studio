package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func show(n *LayoutNode) string {
	if n == nil {
		return "-"
	}
	if n.Type == "leaf" {
		s := itoa(n.Pane)
		if n.Gone {
			s = "x" + s
		}
		return s
	}
	parts := make([]string, len(n.Children))
	for i, c := range n.Children {
		parts[i] = show(c)
	}
	return n.Dir + "(" + strings.Join(parts, ",") + ")"
}

func itoa(i int) string { b, _ := json.Marshal(i); return string(b) }

func mustLayout(t *testing.T, js string) *WebLayout {
	t.Helper()
	var l WebLayout
	if err := json.Unmarshal([]byte(js), &l); err != nil {
		t.Fatal(err)
	}
	return &l
}

func TestSanitizeLayout(t *testing.T) {
	in := mustLayout(t, `{"active":"zz","tabs":[
	  {"id":"a","name":"  Principal ","root":{"type":"split","dir":"row","sizes":[2,1,1],"children":[
	     {"type":"leaf","pane":1},
	     {"type":"split","dir":"row","sizes":[1,1],"children":[{"type":"leaf","pane":2},{"type":"leaf","pane":1}]},
	     {"type":"leaf","pane":-4}]}},
	  {"id":"a","name":"dup","root":null},
	  {"id":"bad id!","name":"x","root":null},
	  {"id":"b","name":"","root":{"type":"split","dir":"col","children":[{"type":"leaf","pane":7,"gone":true},{"type":"leaf","pane":7,"gone":true}]}}]}`)
	out, err := sanitizeLayout(in)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Tabs) != 2 || out.Active != "a" || out.Tabs[0].Name != "Principal" || out.Tabs[1].Name != "" {
		t.Fatalf("tabs: %+v", out)
	}
	// duplicate live pane 1 dropped, same-dir split flattened, bad leaf dropped
	if got := show(out.Tabs[0].Root); got != "row(1,2)" {
		t.Fatalf("root a = %s", got)
	}
	sz := out.Tabs[0].Root.Sizes
	if len(sz) != 2 || sz[0] < 0.66 || sz[0] > 0.67 { // 2 : (1*0.5)
		t.Fatalf("sizes %v", sz)
	}
	// gone leaves may repeat (they are only markers)
	if got := show(out.Tabs[1].Root); got != "col(x7,x7)" {
		t.Fatalf("root b = %s", got)
	}
	if _, err := sanitizeLayout(&WebLayout{}); err == nil {
		t.Fatal("empty layout accepted")
	}
}

func TestResolveLeaves(t *testing.T) {
	l := mustLayout(t, `{"active":"a","tabs":[{"id":"a","name":"A","root":{"type":"split","dir":"row","sizes":[1,1,1,1],"children":[
	   {"type":"leaf","pane":1},
	   {"type":"leaf","pane":2,"host_id":"H1","title":"t2","cwd":"c2"},
	   {"type":"leaf","pane":3,"host_id":"OLD","title":"t3","cwd":"c3"},
	   {"type":"leaf","pane":4,"host_id":"OLD","title":"t4","cwd":"c4"}]}}]}`)
	live := map[int]paneMeta{1: {"t1", "c1"}, 3: {"novo titulo", "c3"}, 4: {"outro", "outro"}}
	refreshed := false
	if !resolveLeaves(l, live, "H1", &refreshed) {
		t.Fatal("expected a change")
	}
	k := l.Tabs[0].Root.Children
	if k[0].HostID != "H1" || k[0].Title != "t1" || k[0].Gone {
		t.Fatalf("leaf 1 (new): %+v", k[0])
	}
	if !k[1].Gone {
		t.Fatalf("leaf 2 (same host, closed) should be gone: %+v", k[1])
	}
	if k[2].Gone || k[2].HostID != "H1" || k[2].Title != "novo titulo" {
		t.Fatalf("leaf 3 (old host, cwd matches) should be adopted: %+v", k[2])
	}
	if !k[3].Gone || k[3].Title != "t4" {
		t.Fatalf("leaf 4 (old host, no match) should be gone and keep its title: %+v", k[3])
	}
	// second pass: only a title refresh
	live[1] = paneMeta{"t1b", "c1"}
	refreshed = false
	if resolveLeaves(l, live, "H1", &refreshed) || !refreshed || k[0].Title != "t1b" {
		t.Fatalf("title refresh: changed/refreshed wrong, %+v", k[0])
	}
}

func TestLayoutPersistenceAndMigration(t *testing.T) {
	dir := t.TempDir()
	// A version-1 file (appearance only, as written by the previous build).
	v1 := `{"version":1,"default":{"theme":"vscode_dark"},"panes":{"28":{"theme":"1984-dark","title":"T","cwd":"C","host_id":"H","updated_at":"2026-09-25T11:19:49-03:00"}},"font_favorites":["JetBrains Mono"],"theme_favorites":[]}`
	if err := os.WriteFile(filepath.Join(dir, webSettingsFile), []byte(v1), 0o644); err != nil {
		t.Fatal(err)
	}
	themes.mu.Lock()
	themes.themes = builtinThemes()
	themes.json = []byte("{}")
	themes.mu.Unlock()

	st := &settingsStore{}
	st.load(dir)
	if st.s.Layout != nil || st.s.Default.Theme != "vscode_dark" || st.s.Panes["28"] == nil {
		t.Fatalf("v1 load: %+v", st.s)
	}
	st.live = map[int]paneMeta{28: {"T", "C"}, 5: {"t5", "c5"}}
	snap, err := st.setLayout(mustLayout(t, `{"active":"a","tabs":[{"id":"a","name":"A","root":{"type":"split","dir":"col","sizes":[1,3],"children":[{"type":"leaf","pane":28},{"type":"leaf","pane":5}]}},{"id":"b","name":"Servidores","root":null}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if snap.Layout == nil || show(snap.Layout.Tabs[0].Root) != "col(28,5)" {
		t.Fatalf("snapshot layout: %+v", snap.Layout)
	}
	// reload from disk
	st2 := &settingsStore{}
	st2.load(dir)
	if st2.s.Version != 2 || st2.s.Layout == nil || len(st2.s.Layout.Tabs) != 2 || st2.s.Layout.Tabs[1].Name != "Servidores" {
		t.Fatalf("reload: %+v", st2.s.Layout)
	}
	if got := show(st2.s.Layout.Tabs[0].Root); got != "col(28,5)" {
		t.Fatalf("reload tree %s", got)
	}
	if sz := st2.s.Layout.Tabs[0].Root.Sizes; sz[0] != 0.25 || sz[1] != 0.75 {
		t.Fatalf("sizes %v", sz)
	}
	if st2.s.Default.Theme != "vscode_dark" || st2.s.Panes["28"].Theme != "1984-dark" || st2.s.FontFavorites[0] != "JetBrains Mono" {
		t.Fatalf("appearance lost in migration: %+v", st2.s)
	}
	leaf := st2.s.Layout.Tabs[0].Root.Children[1]
	if leaf.Title != "t5" || leaf.Cwd != "c5" {
		t.Fatalf("identity not stored: %+v", leaf)
	}
	// atomic write leaves no temp file behind
	if _, err := os.Stat(filepath.Join(dir, webSettingsFile+".tmp-web")); !os.IsNotExist(err) {
		t.Fatal("temp file left behind")
	}
}

func TestClosedGroupsPersistAndPrune(t *testing.T) {
	in := mustLayout(t, `{"active":"a","v":2,"tabs":[{"id":"a","name":"","root":{"type":"leaf","pane":9}}],
	  "closed":[
	    {"id":"c1","name":" Dupla ","closed_at":"2026-09-25T16:00:00-03:00","root":{"type":"split","dir":"col","sizes":[3,1],"children":[{"type":"leaf","pane":1},{"type":"leaf","pane":2}]}},
	    {"id":"c1","name":"dup","root":{"type":"leaf","pane":5}},
	    {"id":"c2","name":"vazia","root":null},
	    {"id":"c3","name":"Outra","root":{"type":"leaf","pane":3}}]}`)
	out, err := sanitizeLayout(in)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Closed) != 2 || out.Closed[0].Name != "Dupla" || show(out.Closed[0].Root) != "col(1,2)" || out.Closed[0].ClosedAt == "" {
		t.Fatalf("closed = %+v", out.Closed)
	}
	if sz := out.Closed[0].Root.Sizes; sz[0] != 0.75 {
		t.Fatalf("tamanhos = %v", sz)
	}
	// identidade dos panes vale tambem nas fechadas
	refreshed := false
	resolveLeaves(out, map[int]paneMeta{9: {"x", "y"}, 1: {"t1", "c1"}}, "H", &refreshed)
	if out.Closed[0].Root.Children[0].Gone || !out.Closed[0].Root.Children[1].Gone || !out.Closed[1].Root.Gone {
		t.Fatalf("resolve = %s / %s", show(out.Closed[0].Root), show(out.Closed[1].Root))
	}
	// "Outra" ficou toda encerrada: marca agora, some depois de 14 dias
	now := time.Now()
	if !pruneClosed(out, now) || out.Closed[1].GoneSince == "" || out.Closed[0].GoneSince != "" {
		t.Fatalf("marca = %+v", out.Closed)
	}
	pruneClosed(out, now.Add(13*24*time.Hour))
	if len(out.Closed) != 2 {
		t.Fatal("sumiu antes de 14 dias")
	}
	pruneClosed(out, now.Add(15*24*time.Hour))
	if len(out.Closed) != 1 || out.Closed[0].ID != "c1" {
		t.Fatalf("depois de 14 dias = %+v", out.Closed)
	}
	// ida e volta em JSON (web-settings.json)
	b, _ := json.Marshal(out)
	back, err := sanitizeLayout(mustLayout(t, string(b)))
	if err != nil || len(back.Closed) != 1 || back.Closed[0].Name != "Dupla" {
		t.Fatalf("json = %s %v", b, err)
	}
}

func TestDropEndedOpenTabs(t *testing.T) {
	l := mustLayout(t, `{"active":"dead","tabs":[
	  {"id":"live","name":"","root":{"type":"leaf","pane":1}},
	  {"id":"dead","name":"ssh","root":{"type":"leaf","pane":2,"gone":true,"title":"root@h"}},
	  {"id":"split","name":"","root":{"type":"split","dir":"row","sizes":[0.5,0.5],"children":[
	    {"type":"leaf","pane":3},
	    {"type":"leaf","pane":4,"gone":true}
	  ]}}
	]}`)
	if !dropEndedOpenTabs(l) {
		t.Fatal("expected a change")
	}
	if len(l.Tabs) != 2 || l.Active != "live" {
		t.Fatalf("tabs=%d active=%s", len(l.Tabs), l.Active)
	}
	if show(l.Tabs[0].Root) != "1" || show(l.Tabs[1].Root) != "3" {
		t.Fatalf("trees %s / %s", show(l.Tabs[0].Root), show(l.Tabs[1].Root))
	}
	only := mustLayout(t, `{"active":"a","tabs":[{"id":"a","name":"ssh","root":{"type":"leaf","pane":9,"gone":true}}]}`)
	if !dropEndedOpenTabs(only) || len(only.Tabs) != 1 || only.Tabs[0].Root != nil || only.Active != "a" {
		t.Fatalf("last tab should become empty: %+v", only.Tabs)
	}
	if dropEndedOpenTabs(only) {
		t.Fatal("empty tab should stay")
	}
}

func TestSidebarKindOrderAndSplit(t *testing.T) {
	st := &settingsStore{}
	st.load(t.TempDir())
	off := false
	snap, err := st.setSidebar(SidebarPrefs{View: "web", KindOrder: []string{"ssh", "wsl"}, SplitByKind: &off})
	if err != nil || len(snap.Sidebar.KindOrder) != 2 || snap.Sidebar.KindOrder[0] != "ssh" || snap.Sidebar.SplitByKind == nil || *snap.Sidebar.SplitByKind {
		t.Fatalf("sidebar = %+v %v", snap.Sidebar, err)
	}
	if _, err := st.setSidebar(SidebarPrefs{KindOrder: []string{""}}); err == nil {
		t.Fatal("ordem inválida aceita")
	}
}
