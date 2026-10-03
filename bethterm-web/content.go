package main

// content.go — visible screen text of panes, for "procurar também no
// conteúdo da tela" in the search UI.
//
// POST /api/content {"pane_ids":[...]} (empty = every pane of the last list)
// -> {"panes":{"28":"plain text\nrows..."}, "missing":[...], "ms":N}
//
// Sources, cheapest first:
//  1. panes some browser watches: the last screen already cached by the hub;
//  2. a per-pane cache of earlier snapshots, reused for contentTTL;
//  3. the rest: ONE temporary bridge `watch` of (current union ∪ missing),
//     wait for their first screen (the bridge re-sends every watched pane on
//     a watch change), then restore the union.
//
// Cost: step 3 makes the bridge read every missing pane once (measured
// ~1–2 ms per pane on the live host, a 17-pane snapshot ≈ 20–40 ms) and
// re-sends one screen to every current viewer. It only runs on demand (the
// UI calls this only when the user ticks "procurar também no conteúdo"),
// one snapshot at a time, at most maxContentPanes panes, and results are
// cached for contentTTL, so typing does not trigger new snapshots.

import (
	"encoding/json"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	contentTTL      = 5 * time.Second
	contentTimeout  = 2 * time.Second
	maxContentPanes = 64
)

type contentCollector struct {
	want map[int]bool
	got  map[int]string
	done chan struct{}
}

type cachedText struct {
	text string
	at   time.Time
}

type contentState struct {
	snapMu sync.Mutex // one snapshot at a time
	cache  map[int]cachedText
	coll   *contentCollector
}

// ansiRe matches CSI, OSC (BEL or ST terminated), charset designations and
// other two-byte escapes.
var ansiRe = regexp.MustCompile("\x1b\\[[0-9;:?<=>!]*[ -/]*[@-~]|\x1b\\][^\x07\x1b]*(?:\x07|\x1b\\\\)|\x1b[()*+][0-9A-Za-z]|\x1b[@-Z\\\\-_=>78]")

// plainText strips escapes and trailing blanks; rows joined with "\n".
func plainText(sgr string) string {
	s := ansiRe.ReplaceAllString(sgr, "")
	rows := strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
	for i, r := range rows {
		rows[i] = strings.TrimRight(r, " \t\r")
	}
	// drop trailing empty rows
	n := len(rows)
	for n > 0 && rows[n-1] == "" {
		n--
	}
	return strings.Join(rows[:n], "\n")
}

func screenText(raw []byte) (int, string, bool) {
	var ev struct {
		PaneID *int   `json:"pane_id"`
		Text   string `json:"text"`
	}
	if json.Unmarshal(raw, &ev) != nil || ev.PaneID == nil {
		return 0, "", false
	}
	return *ev.PaneID, plainText(ev.Text), true
}

// onScreenForContent is called by hub.fromBridge (with h.mu held) for every
// screen event.
func (h *hub) onScreenForContentLocked(id int, raw []byte) {
	c := h.content.coll
	if c == nil || !c.want[id] {
		return
	}
	if _, done := c.got[id]; done {
		return
	}
	if _, text, ok := screenText(raw); ok {
		c.got[id] = text
		h.content.cache[id] = cachedText{text, time.Now()}
		if len(c.got) == len(c.want) {
			close(c.done)
		}
	}
}

func (h *hub) livePaneIDs() []int {
	h.mu.Lock()
	list := h.lastList
	h.mu.Unlock()
	var ev struct {
		Panes []struct {
			PaneID int `json:"pane_id"`
		} `json:"panes"`
	}
	if list == nil || json.Unmarshal(list, &ev) != nil {
		return nil
	}
	ids := make([]int, 0, len(ev.Panes))
	for _, p := range ev.Panes {
		ids = append(ids, p.PaneID)
	}
	return ids
}

// paneContents returns the plain visible text of each requested pane.
func (h *hub) paneContents(ids []int) (map[int]string, []int) {
	if len(ids) == 0 {
		ids = h.livePaneIDs()
	}
	if len(ids) > maxContentPanes {
		ids = ids[:maxContentPanes]
	}
	out := map[int]string{}
	var missing []int
	h.mu.Lock()
	for _, id := range ids {
		if raw, ok := h.screens[id]; ok { // watched by some browser: fresh
			if _, t, ok := screenText(raw); ok {
				out[id] = t
				continue
			}
		}
		if c, ok := h.content.cache[id]; ok && time.Since(c.at) < contentTTL {
			out[id] = c.text
			continue
		}
		missing = append(missing, id)
	}
	h.mu.Unlock()
	if len(missing) == 0 || h.bridge == nil {
		return out, missing
	}

	h.content.snapMu.Lock()
	defer h.content.snapMu.Unlock()
	coll := &contentCollector{want: map[int]bool{}, got: map[int]string{}, done: make(chan struct{})}
	for _, id := range missing {
		coll.want[id] = true
	}
	h.mu.Lock()
	h.content.coll = coll
	set := map[int]bool{}
	for _, id := range h.union {
		set[id] = true
	}
	for _, id := range missing {
		set[id] = true
	}
	h.mu.Unlock()
	tmp := make([]int, 0, len(set))
	for id := range set {
		tmp = append(tmp, id)
	}
	sort.Ints(tmp)
	err := h.bridge.write(map[string]any{"op": "watch", "pane_ids": tmp})
	if err == nil {
		select {
		case <-coll.done:
		case <-time.After(contentTimeout):
		}
	}
	h.mu.Lock()
	h.content.coll = nil
	restore := append([]int{}, h.union...)
	for id, t := range coll.got {
		out[id] = t
	}
	h.mu.Unlock()
	// Back to exactly what the browsers watch.
	_ = h.bridge.write(map[string]any{"op": "watch", "pane_ids": restore})
	var still []int
	for _, id := range missing {
		if _, ok := coll.got[id]; !ok {
			still = append(still, id)
		}
	}
	return out, still
}

func (s *server) serveContent(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		return
	}
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "use application/json", http.StatusUnsupportedMediaType)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	var req struct {
		PaneIDs []int `json:"pane_ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
		return
	}
	for _, id := range req.PaneIDs {
		if id < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "pane_id inválido"})
			return
		}
	}
	start := time.Now()
	got, missing := s.hub.paneContents(req.PaneIDs)
	panes := make(map[string]string, len(got))
	for id, t := range got {
		panes[strconv.Itoa(id)] = t
	}
	if missing == nil {
		missing = []int{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"panes": panes, "missing": missing, "ms": time.Since(start).Milliseconds()})
}

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }
