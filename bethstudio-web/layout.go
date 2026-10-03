package main

// layout.go — the web's OWN organisation (tabs + split trees), stored in
// web-settings.json under "layout". It never changes anything in the host.
//
// The tree shape is owned by the frontend (frontend/src/lib/layout.ts); here
// it is validated (limits, one live leaf per pane, sane sizes) and every
// leaf gets the pane identity used for appearance too: host id + title +
// cwd. A leaf whose pane closed, or that belongs to a previous host and no
// longer matches by title/cwd, is marked `gone` and then removed from the
// open tabs (dropEndedOpenTabs): the split collapses, and a tab with no
// live terminal closes. Closed groups keep the marker so a later match can
// still adopt them. A new pane that reuses the id is never confused with it.

import (
	"errors"
	"math"
	"regexp"
	"strings"
	"time"
)

type LayoutNode struct {
	Type     string        `json:"type"` // leaf | split
	Pane     int           `json:"pane"`
	Gone     bool          `json:"gone,omitempty"`
	Title    string        `json:"title,omitempty"`
	Cwd      string        `json:"cwd,omitempty"`
	HostID   string        `json:"host_id,omitempty"`
	Dir      string        `json:"dir,omitempty"` // row | col
	Sizes    []float64     `json:"sizes,omitempty"`
	Children []*LayoutNode `json:"children,omitempty"`
}

type LayoutTab struct {
	ID   string      `json:"id"`
	Name string      `json:"name"`
	Root *LayoutNode `json:"root"`
	// So' em Closed: quando a aba foi fechada e desde quando todos os
	// terminais dela estao encerrados (some 14 dias depois).
	ClosedAt  string `json:"closed_at,omitempty"`
	GoneSince string `json:"gone_since,omitempty"`
}

type WebLayout struct {
	Tabs   []LayoutTab `json:"tabs"`
	Active string      `json:"active"`
	// V2: "name" das abas passou a ser so' o nome dado pelo usuario
	// (vazio = acompanha o terminal). Layouts sem V sao migrados pela UI.
	V int `json:"v,omitempty"`
	// Abas fechadas ("grupos fechados"), a mais recente primeiro: clicar num
	// terminal delas reabre a aba inteira (layout.ts restoreClosed).
	Closed []LayoutTab `json:"closed,omitempty"`
}

const (
	maxClosed      = 20
	maxTabs        = 30
	maxLeavesTotal = 96
	maxDepth       = 8
	maxChildren    = 12
)

var tabIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)

// sanitizeLayout validates and normalises a layout posted by the UI.
func sanitizeLayout(in *WebLayout) (*WebLayout, error) {
	if in == nil || len(in.Tabs) == 0 {
		return nil, errors.New("layout sem abas")
	}
	if len(in.Tabs) > maxTabs {
		return nil, errors.New("abas demais")
	}
	seenPane := map[int]bool{}
	seenTab := map[string]bool{}
	leavesTotal := 0
	var node func(n *LayoutNode, depth int) *LayoutNode
	node = func(n *LayoutNode, depth int) *LayoutNode {
		if n == nil || depth > maxDepth {
			return nil
		}
		switch n.Type {
		case "leaf":
			if n.Pane < 0 || leavesTotal >= maxLeavesTotal {
				return nil
			}
			if !n.Gone {
				if seenPane[n.Pane] {
					return nil
				}
				seenPane[n.Pane] = true
			}
			leavesTotal++
			return &LayoutNode{Type: "leaf", Pane: n.Pane, Gone: n.Gone, Title: clip(n.Title, 300), Cwd: clip(n.Cwd, 1000), HostID: clip(n.HostID, 80)}
		case "split":
			if n.Dir != "row" && n.Dir != "col" {
				return nil
			}
			var kids []*LayoutNode
			var sizes []float64
			for i, c := range n.Children {
				if len(kids) >= maxChildren {
					break
				}
				k := node(c, depth+1)
				if k == nil {
					continue
				}
				s := 1.0
				if len(n.Sizes) == len(n.Children) {
					s = n.Sizes[i]
				}
				// Same-direction child: flatten, like normalize() in layout.ts.
				if k.Type == "split" && k.Dir == n.Dir {
					for j, cc := range k.Children {
						kids = append(kids, cc)
						sizes = append(sizes, s*k.Sizes[j])
					}
					continue
				}
				kids = append(kids, k)
				sizes = append(sizes, s)
			}
			switch len(kids) {
			case 0:
				return nil
			case 1:
				return kids[0]
			}
			return &LayoutNode{Type: "split", Dir: n.Dir, Children: kids, Sizes: normSizes(sizes)}
		}
		return nil
	}
	out := &WebLayout{V: in.V}
	for _, t := range in.Tabs {
		if !tabIDRe.MatchString(t.ID) || seenTab[t.ID] {
			continue
		}
		seenTab[t.ID] = true
		// Nome vazio = a aba acompanha o titulo do terminal (a UI decide).
		name := clip(strings.TrimSpace(t.Name), 60)
		out.Tabs = append(out.Tabs, LayoutTab{ID: t.ID, Name: name, Root: node(t.Root, 0)})
	}
	if len(out.Tabs) == 0 {
		return nil, errors.New("layout sem abas válidas")
	}
	// Abas fechadas: validadas a' parte (os panes delas nao estao em abas).
	seenPane = map[int]bool{}
	leavesTotal = 0
	for _, t := range in.Closed {
		if len(out.Closed) >= maxClosed {
			break
		}
		if !tabIDRe.MatchString(t.ID) || seenTab[t.ID] {
			continue
		}
		root := node(t.Root, 0)
		if root == nil {
			continue
		}
		seenTab[t.ID] = true
		out.Closed = append(out.Closed, LayoutTab{ID: t.ID, Name: clip(strings.TrimSpace(t.Name), 60), Root: root,
			ClosedAt: clip(t.ClosedAt, 40), GoneSince: clip(t.GoneSince, 40)})
	}
	out.Active = out.Tabs[0].ID
	for _, t := range out.Tabs {
		if t.ID == in.Active {
			out.Active = in.Active
		}
	}
	return out, nil
}

func normSizes(s []float64) []float64 {
	out := make([]float64, len(s))
	sum := 0.0
	for i, x := range s {
		if math.IsNaN(x) || math.IsInf(x, 0) || x <= 0 {
			x = 0
		}
		out[i] = x
		sum += x
	}
	for _, x := range out {
		if x <= 0 {
			sum = 0
			break
		}
	}
	if sum <= 0 {
		for i := range out {
			out[i] = 1 / float64(len(out))
		}
		return out
	}
	for i := range out {
		out[i] /= sum
	}
	return out
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func forEachLeaf(l *WebLayout, f func(n *LayoutNode)) {
	if l == nil {
		return
	}
	var walk func(n *LayoutNode)
	walk = func(n *LayoutNode) {
		if n == nil {
			return
		}
		if n.Type == "leaf" {
			f(n)
			return
		}
		for _, c := range n.Children {
			walk(c)
		}
	}
	for _, t := range l.Tabs {
		walk(t.Root)
	}
	for _, t := range l.Closed {
		walk(t.Root)
	}
}

// pruneClosed: aba fechada com todos os terminais encerrados ganha
// GoneSince e some 14 dias depois; se algum voltar, a marca e' limpa.
func pruneClosed(l *WebLayout, now time.Time) bool {
	if l == nil || len(l.Closed) == 0 {
		return false
	}
	changed := false
	kept := l.Closed[:0]
	for _, t := range l.Closed {
		alive := false
		var walk func(n *LayoutNode)
		walk = func(n *LayoutNode) {
			if n == nil {
				return
			}
			if n.Type == "leaf" && !n.Gone {
				alive = true
			}
			for _, c := range n.Children {
				walk(c)
			}
		}
		walk(t.Root)
		switch {
		case alive:
			if t.GoneSince != "" {
				t.GoneSince = ""
				changed = true
			}
		case t.GoneSince == "":
			t.GoneSince = now.Format(time.RFC3339)
			changed = true
		default:
			if g, err := time.Parse(time.RFC3339, t.GoneSince); err != nil || now.Sub(g) > 14*24*time.Hour {
				changed = true
				continue
			}
		}
		kept = append(kept, t)
	}
	l.Closed = kept
	return changed
}

// resolveLeaves applies the pane identity rules to every leaf. It returns
// true when something structural changed (gone flag, adoption) and sets
// *refreshed when only titles/cwds were refreshed.
//
//   - same host: refresh title/cwd; pane missing from the list => gone.
//   - no identity yet (just posted by the UI): take it from the live list;
//     pane missing => gone.
//   - previous host: adopt when title or cwd still match the pane that has
//     this id now, otherwise gone.
func resolveLeaves(l *WebLayout, live map[int]paneMeta, host string, refreshed *bool) bool {
	changed := false
	forEachLeaf(l, func(n *LayoutNode) {
		if n.Gone {
			return
		}
		m, alive := live[n.Pane]
		switch {
		case n.HostID == "" || (host != "" && n.HostID == host):
			if !alive {
				n.Gone = true
				changed = true
				return
			}
			if n.HostID == "" {
				n.HostID = host
				changed = true
			}
			if n.Title != m.title || n.Cwd != m.cwd {
				n.Title, n.Cwd = m.title, m.cwd
				*refreshed = true
			}
		case alive && ((n.Cwd != "" && n.Cwd == m.cwd) || (n.Title != "" && n.Title == m.title)):
			n.HostID, n.Title, n.Cwd = host, m.title, m.cwd
			changed = true
		default:
			n.Gone = true
			changed = true
		}
	})
	return changed
}

// dropEndedOpenTabs tira das abas abertas o terminal que já encerrou.
// O split que sobra com um filho só colapsa. A aba que fica sem nenhum
// terminal vivo fecha; se era a última, fica uma aba vazia.
func dropEndedOpenTabs(l *WebLayout) bool {
	if l == nil || len(l.Tabs) == 0 {
		return false
	}
	changed := false
	tabs := make([]LayoutTab, 0, len(l.Tabs))
	activeGone := false
	for _, t := range l.Tabs {
		root, dropped := withoutGone(t.Root)
		if dropped {
			changed = true
		}
		if root == nil && t.Root != nil {
			changed = true
			if t.ID == l.Active {
				activeGone = true
			}
			continue
		}
		t.Root = root
		tabs = append(tabs, t)
	}
	if !changed {
		return false
	}
	if len(tabs) == 0 {
		id := l.Tabs[0].ID
		if id == "" {
			id = "a"
		}
		tabs = []LayoutTab{{ID: id}}
		l.Active = id
	} else if activeGone || !layoutHasTab(tabs, l.Active) {
		l.Active = tabs[0].ID
	}
	l.Tabs = tabs
	return true
}

func layoutHasTab(tabs []LayoutTab, id string) bool {
	for _, t := range tabs {
		if t.ID == id {
			return true
		}
	}
	return false
}

func withoutGone(n *LayoutNode) (*LayoutNode, bool) {
	if n == nil {
		return nil, false
	}
	if n.Type == "leaf" {
		if n.Gone {
			return nil, true
		}
		return n, false
	}
	if n.Type != "split" {
		return n, false
	}
	var kids []*LayoutNode
	var sizes []float64
	changed := false
	for i, c := range n.Children {
		k, dropped := withoutGone(c)
		if dropped {
			changed = true
		}
		if k == nil {
			continue
		}
		s := 1.0
		if i < len(n.Sizes) && n.Sizes[i] > 0 {
			s = n.Sizes[i]
		}
		kids = append(kids, k)
		sizes = append(sizes, s)
	}
	switch len(kids) {
	case 0:
		return nil, true
	case 1:
		return kids[0], true
	default:
		n.Children = kids
		n.Sizes = normSizes(sizes)
		return n, changed
	}
}
