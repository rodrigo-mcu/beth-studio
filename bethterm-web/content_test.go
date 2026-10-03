package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// fakeBridgeStdin plays the bridge: every `watch` request makes it emit one
// screen per requested pane (like the real bridge after a watch change).
type fakeBridgeStdin struct {
	h       *hub
	mu      sync.Mutex
	watches [][]int
	skip    map[int]bool // panes that never answer
}

func (f *fakeBridgeStdin) Write(p []byte) (int, error) {
	var req struct {
		Op      string `json:"op"`
		PaneIDs []int  `json:"pane_ids"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(p), &req); err != nil {
		return 0, err
	}
	if req.Op == "watch" {
		f.mu.Lock()
		f.watches = append(f.watches, append([]int{}, req.PaneIDs...))
		f.mu.Unlock()
		ids := append([]int{}, req.PaneIDs...)
		go func() {
			for _, id := range ids {
				if f.skip[id] {
					continue
				}
				text := fmt.Sprintf("\x1b[0m\x1b[1;32mpane %d\x1b[0m olá \x1b]8;;file:///x\x1b\\link\x1b]8;;\x1b\\  \r\n\x1b(Bsegunda linha %d   \r\n   ", id, id)
				ev, _ := json.Marshal(map[string]any{"ev": "screen", "pane_id": id, "cols": 80, "rows": 3, "text": text})
				f.h.fromBridge(ev)
			}
		}()
	}
	return len(p), nil
}

func (f *fakeBridgeStdin) Close() error { return nil }

func newFakeHub(t *testing.T, skip ...int) (*hub, *fakeBridgeStdin) {
	t.Helper()
	h := newHub(true)
	br := newBridge("fake.exe", h)
	h.bridge = br
	f := &fakeBridgeStdin{h: h, skip: map[int]bool{}}
	for _, id := range skip {
		f.skip[id] = true
	}
	br.stdin = f
	list, _ := json.Marshal(map[string]any{"ev": "list", "panes": []map[string]any{
		{"pane_id": 1, "title": "a"}, {"pane_id": 2, "title": "b"}, {"pane_id": 3, "title": "c"},
	}})
	h.mu.Lock()
	h.lastList = list
	h.union = []int{1}
	h.mu.Unlock()
	return h, f
}

func TestPlainText(t *testing.T) {
	in := "\x1b[0m\x1b[38;2;1;2;3mA\x1b[0m b \x1b]8;;http://x\x07L\x1b]8;;\x07  \r\n\x1b(Bc\x1b[?25l  \r\n  \r\n"
	if got := plainText(in); got != "A b L\nc" {
		t.Fatalf("plainText = %q", got)
	}
}

func TestPaneContentsSnapshotAndRestore(t *testing.T) {
	h, f := newFakeHub(t)
	got, missing := h.paneContents(nil) // all panes of the list
	if len(missing) != 0 || len(got) != 3 {
		t.Fatalf("got %v missing %v", got, missing)
	}
	if got[2] != "pane 2 olá link\nsegunda linha 2" {
		t.Fatalf("pane 2 text = %q", got[2])
	}
	f.mu.Lock()
	w := f.watches
	f.mu.Unlock()
	// one temporary watch (union ∪ missing) and then back to the union
	if len(w) != 2 || fmt.Sprint(w[0]) != "[1 2 3]" || fmt.Sprint(w[1]) != "[1]" {
		t.Fatalf("watch requests = %v", w)
	}
	// second call inside contentTTL: served from cache, no new watch
	if _, missing := h.paneContents([]int{2, 3}); len(missing) != 0 {
		t.Fatal("cache miss")
	}
	f.mu.Lock()
	n := len(f.watches)
	f.mu.Unlock()
	if n != 2 {
		t.Fatalf("cache not used: %d watches", n)
	}
}

func TestPaneContentsTimeoutReportsMissing(t *testing.T) {
	h, _ := newFakeHub(t, 3)
	got, missing := h.paneContents([]int{2, 3})
	if got[2] == "" || len(missing) != 1 || missing[0] != 3 {
		t.Fatalf("got %v missing %v", got, missing)
	}
}

func TestContentEndpoint(t *testing.T) {
	h, _ := newFakeHub(t)
	srv := newServer("tok", 5555, "", h)
	do := func(method, body, token, ctype string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://127.0.0.1:5555/api/content", strings.NewReader(body))
		req.Host = "127.0.0.1:5555"
		if token != "" {
			req.Header.Set(tokenHeader, token)
		}
		if ctype != "" {
			req.Header.Set("Content-Type", ctype)
		}
		rr := httptest.NewRecorder()
		srv.ServeHTTP(rr, req)
		return rr
	}
	if rr := do("POST", `{}`, "", "application/json"); rr.Code != http.StatusUnauthorized {
		t.Fatalf("no token: %d", rr.Code)
	}
	if rr := do("POST", `{}`, "tok", "text/plain"); rr.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("text/plain: %d", rr.Code)
	}
	if rr := do("POST", `{"pane_ids":[-1]}`, "tok", "application/json"); rr.Code != http.StatusBadRequest {
		t.Fatalf("negative id: %d", rr.Code)
	}
	rr := do("POST", `{"pane_ids":[1,3]}`, "tok", "application/json")
	if rr.Code != http.StatusOK {
		t.Fatalf("ok: %d %s", rr.Code, rr.Body)
	}
	var out struct {
		Panes   map[string]string `json:"panes"`
		Missing []int             `json:"missing"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(out.Panes["3"], "pane 3 olá") || len(out.Missing) != 0 {
		t.Fatalf("body %s", rr.Body)
	}
}
