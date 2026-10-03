package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

// scriptBridge: fake bridge stdin that answers shells/spawn like patch 0176
// and records every request (nothing reaches a real host).
type scriptBridge struct {
	h    *hub
	mu   sync.Mutex
	reqs []map[string]any
}

func (f *scriptBridge) Write(p []byte) (int, error) {
	var req map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(p), &req); err != nil {
		return 0, err
	}
	f.mu.Lock()
	f.reqs = append(f.reqs, req)
	f.mu.Unlock()
	switch req["op"] {
	case "shells":
		go f.h.fromBridge([]byte(`{"ev":"shells","shells":[{"id":"powershell","label":"PowerShell 5.1"},{"id":"wsl.ubuntu","label":"WSL Ubuntu"}]}`))
	case "spawn":
		rid, _ := req["request_id"].(string)
		ev, _ := json.Marshal(map[string]any{"ev": "spawned", "request_id": rid, "pane_id": 40, "tab_id": 30, "window_id": req["window_id"]})
		go f.h.fromBridge(ev)
	}
	return len(p), nil
}
func (f *scriptBridge) Close() error { return nil }

func (f *scriptBridge) last() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.reqs) == 0 {
		return nil
	}
	return f.reqs[len(f.reqs)-1]
}

func newScriptHub(readOnly bool) (*hub, *scriptBridge, *server) {
	h := newHub(readOnly)
	br := newBridge("fake.exe", h)
	h.bridge = br
	f := &scriptBridge{h: h}
	br.stdin = f
	return h, f, &server{hub: h}
}

// drain collects the events queued for a client.
func drain(c *client, wait time.Duration) []map[string]any {
	var out []map[string]any
	deadline := time.After(wait)
	for {
		select {
		case m := <-c.out:
			var ev map[string]any
			_ = json.Unmarshal(m, &ev)
			out = append(out, ev)
		case <-deadline:
			return out
		}
	}
}

func evs(list []map[string]any, kind string) []map[string]any {
	var out []map[string]any
	for _, e := range list {
		if e["ev"] == kind {
			out = append(out, e)
		}
	}
	return out
}

func TestAgentStateReplayAndClear(t *testing.T) {
	h, _, s := newScriptHub(false)
	c1 := h.add()
	h.fromBridge([]byte(`{"ev":"agent","pane_id":7,"waiting":true,"reason":"user_var","detail":"claude_status=waiting"}`))
	h.fromBridge([]byte(`{"ev":"agent","pane_id":8,"waiting":true,"reason":"bell","detail":""}`))
	if got := evs(drain(c1, 50*time.Millisecond), "agent"); len(got) != 2 {
		t.Fatalf("c1 agent events = %v", got)
	}
	// A browser that connects later gets the current state.
	c2 := h.add()
	got := evs(drain(c2, 50*time.Millisecond), "agent")
	if len(got) != 2 {
		t.Fatalf("replay = %v", got)
	}
	// Typing in pane 7 (bridge: waiting:false, reason input) clears it.
	h.fromBridge([]byte(`{"ev":"agent","pane_id":7,"waiting":false,"reason":"input"}`))
	// "dispensar" clears pane 8 for everybody.
	var errs []string
	s.handle(c1, clientRequest{Op: "dismiss_agent", PaneID: intp(8)}, func(m string) { errs = append(errs, m) })
	if len(errs) != 0 {
		t.Fatal(errs)
	}
	c3 := h.add()
	if got := evs(drain(c3, 50*time.Millisecond), "agent"); len(got) != 0 {
		t.Fatalf("state should be empty, got %v", got)
	}
	d := evs(drain(c1, 50*time.Millisecond), "agent")
	if len(d) != 2 || d[1]["reason"] != "dismissed" || d[1]["waiting"] != false {
		t.Fatalf("broadcast of clear/dismiss = %v", d)
	}
}

func intp(i int) *int       { return &i }
func strp(s string) *string { return &s }

func TestShellsAndSpawnRelay(t *testing.T) {
	h, f, s := newScriptHub(false)
	c := h.add()
	var errs []string
	e := func(m string) { errs = append(errs, m) }

	s.handle(c, clientRequest{Op: "shells"}, e)
	sh := evs(drain(c, 80*time.Millisecond), "shells")
	if len(sh) != 1 || len(sh[0]["shells"].([]any)) != 2 {
		t.Fatalf("shells = %v", sh)
	}
	// cached shells go to a browser that connects later
	if len(evs(drain(h.add(), 30*time.Millisecond), "shells")) != 1 {
		t.Fatal("shells not replayed")
	}

	s.handle(c, clientRequest{Op: "spawn", ShellID: "powershell", Window: intp(3), Cwd: strp(`C:\src`), ReqID: "r1"}, e)
	sp := evs(drain(c, 80*time.Millisecond), "spawned")
	if len(errs) != 0 || len(sp) != 1 || sp[0]["request_id"] != "r1" || sp[0]["pane_id"].(float64) != 40 {
		t.Fatalf("spawned = %v errs %v", sp, errs)
	}
	req := f.last()
	if req["shell_id"] != "powershell" || req["cwd"] != `C:\src` || req["window_id"].(float64) != 3 {
		t.Fatalf("forwarded = %v", req)
	}
	// without window_id / cwd: those keys are not sent
	s.handle(c, clientRequest{Op: "spawn", ShellID: "wsl.ubuntu"}, e)
	req = f.last()
	if _, ok := req["window_id"]; ok {
		t.Fatalf("window_id should be absent: %v", req)
	}
	if _, ok := req["cwd"]; ok {
		t.Fatalf("cwd should be absent: %v", req)
	}
}

func TestSpawnValidationAndReadOnly(t *testing.T) {
	cases := []clientRequest{
		{Op: "spawn", ShellID: "Power Shell"},
		{Op: "spawn", ShellID: "cmd;calc"},
		{Op: "spawn", ShellID: ""},
		{Op: "spawn", ShellID: "cmd", Window: intp(-1)},
		{Op: "spawn", ShellID: "cmd", Cwd: strp(strings.Repeat("a", 1025))},
		{Op: "spawn", ShellID: "cmd", Cwd: strp("C:\\x\x00y")},
		{Op: "spawn", ShellID: "cmd", ReqID: "r 1"},
	}
	h, f, s := newScriptHub(false)
	c := h.add()
	for i, req := range cases {
		var errs []string
		s.handle(c, req, func(m string) { errs = append(errs, m) })
		if len(errs) != 1 {
			t.Fatalf("case %d accepted: %+v", i, req)
		}
	}
	if f.last() != nil {
		t.Fatalf("an invalid spawn reached the bridge: %v", f.last())
	}
	hr, fr, sr := newScriptHub(true)
	var errs []string
	sr.handle(hr.add(), clientRequest{Op: "spawn", ShellID: "cmd"}, func(m string) { errs = append(errs, m) })
	if len(errs) != 1 || !strings.Contains(errs[0], "somente leitura") || fr.last() != nil {
		t.Fatalf("read-only spawn: errs=%v req=%v", errs, fr.last())
	}
}

func TestResizeValidation(t *testing.T) {
	h, f, s := newScriptHub(false)
	c := h.add()
	bad := []clientRequest{
		{Op: "resize", PaneID: intp(-1), Cols: intp(80), Rows: intp(24)},
		{Op: "resize", PaneID: intp(1), Cols: intp(9), Rows: intp(24)},
		{Op: "resize", PaneID: intp(1), Cols: intp(501), Rows: intp(24)},
		{Op: "resize", PaneID: intp(1), Cols: intp(80), Rows: intp(3)},
		{Op: "resize", PaneID: intp(1), Cols: intp(80), Rows: intp(301)},
		{Op: "resize", PaneID: intp(1), Cols: intp(80)},
	}
	for i, r := range bad {
		var errs []string
		s.handle(c, r, func(m string) { errs = append(errs, m) })
		if len(errs) != 1 {
			t.Fatalf("case %d accepted", i)
		}
	}
	if f.last() != nil {
		t.Fatalf("invalid resize reached the bridge: %v", f.last())
	}
	var errs []string
	s.handle(c, clientRequest{Op: "resize", PaneID: intp(7), Cols: intp(120), Rows: intp(40)}, func(m string) { errs = append(errs, m) })
	if r := f.last(); len(errs) != 0 || r["op"] != "resize" || r["cols"].(float64) != 120 || r["rows"].(float64) != 40 || r["pane_id"].(float64) != 7 {
		t.Fatalf("forwarded %v errs %v", r, errs)
	}
	hr, fr, sr := newScriptHub(true)
	errs = nil
	sr.handle(hr.add(), clientRequest{Op: "resize", PaneID: intp(7), Cols: intp(120), Rows: intp(40)}, func(m string) { errs = append(errs, m) })
	if len(errs) != 1 || fr.last() != nil {
		t.Fatal("read-only resize not blocked")
	}
}

func TestPaneGoneAndOldBridgeError(t *testing.T) {
	h, _, _ := newScriptHub(false)
	c := h.add()
	h.fromBridge([]byte(`{"ev":"agent","pane_id":32,"waiting":true,"reason":"bell"}`))
	h.mu.Lock()
	h.screens[32] = []byte(`{"ev":"screen","pane_id":32,"text":"x"}`)
	h.mu.Unlock()
	// ponte antiga: erro "no such pane" nao chega ao navegador
	h.fromBridge([]byte(`{"ev":"error","message":"screen of pane 32: unexpected response Ok(ErrorResponse(ErrorResponse { reason: \"Error: no such pane 32\" }))"}`))
	// ponte nova: pane_gone chega e limpa o estado
	h.fromBridge([]byte(`{"ev":"pane_gone","pane_id":32}`))
	got := drain(c, 50*time.Millisecond)
	if len(evs(got, "error")) != 0 {
		t.Fatalf("'no such pane' leaked: %v", got)
	}
	if g := evs(got, "pane_gone"); len(g) != 1 || g[0]["pane_id"].(float64) != 32 {
		t.Fatalf("pane_gone = %v", got)
	}
	h.mu.Lock()
	_, sc := h.screens[32]
	_, ag := h.agents[32]
	h.mu.Unlock()
	if sc || ag {
		t.Fatal("state of the closed pane kept")
	}
	// outros erros continuam passando
	h.fromBridge([]byte(`{"ev":"error","message":"spawn cmd (request r1): falhou"}`))
	if len(evs(drain(c, 50*time.Millisecond), "error")) != 1 {
		t.Fatal("real error swallowed")
	}
}

func TestKillRelayAndReadOnly(t *testing.T) {
	h, f, s := newScriptHub(false)
	c := h.add()
	var errs []string
	e := func(m string) { errs = append(errs, m) }
	s.handle(c, clientRequest{Op: "kill", PaneID: intp(-1)}, e)
	s.handle(c, clientRequest{Op: "kill"}, e)
	if len(errs) != 2 || f.last() != nil {
		t.Fatalf("invalid kill: errs=%v req=%v", errs, f.last())
	}
	errs = nil
	s.handle(c, clientRequest{Op: "kill", PaneID: intp(32)}, e)
	if r := f.last(); len(errs) != 0 || r["op"] != "kill" || r["pane_id"].(float64) != 32 || len(r) != 2 {
		t.Fatalf("kill forwarded = %v errs %v", r, errs)
	}
	hr, fr, sr := newScriptHub(true)
	errs = nil
	sr.handle(hr.add(), clientRequest{Op: "kill", PaneID: intp(32)}, e)
	if len(errs) != 1 || fr.last() != nil {
		t.Fatal("read-only kill not blocked")
	}
}

func TestSeparateRelayAndReadOnly(t *testing.T) {
	h, f, s := newScriptHub(false)
	c := h.add()
	var errs []string
	e := func(m string) { errs = append(errs, m) }
	s.handle(c, clientRequest{Op: "separate", PaneID: intp(-2)}, e)
	if len(errs) != 1 || f.last() != nil {
		t.Fatal("invalid separate accepted")
	}
	errs = nil
	s.handle(c, clientRequest{Op: "separate", PaneID: intp(31)}, e)
	if r := f.last(); len(errs) != 0 || r["op"] != "separate" || r["pane_id"].(float64) != 31 || len(r) != 2 {
		t.Fatalf("separate forwarded = %v", r)
	}
	// o evento "separated" chega a todos os navegadores
	h.fromBridge([]byte(`{"ev":"separated","pane_id":31,"tab_id":40,"window_id":18}`))
	if got := evs(drain(c, 50*time.Millisecond), "separated"); len(got) != 1 {
		t.Fatalf("separated not relayed: %v", got)
	}
	hr, fr, sr := newScriptHub(true)
	errs = nil
	sr.handle(hr.add(), clientRequest{Op: "separate", PaneID: intp(31)}, e)
	if len(errs) != 1 || fr.last() != nil {
		t.Fatal("read-only separate not blocked")
	}
}

func TestRequestsBeforeBridgeIsUp(t *testing.T) {
	h := newHub(false)
	br := newBridge("fake.exe", h) // stdin nil: ponte ainda subindo
	h.bridge = br
	s := &server{hub: h}
	c := h.add()
	var errs []string
	e := func(m string) { errs = append(errs, m) }
	s.handle(c, clientRequest{Op: "list"}, e)
	s.handle(c, clientRequest{Op: "watch", PaneIDs: []int{3}}, e)
	s.handle(c, clientRequest{Op: "scroll", PaneID: intp(3), Offset: intp(40)}, e)
	s.handle(c, clientRequest{Op: "shells"}, e)
	if len(errs) != 0 {
		t.Fatalf("background requests produced errors: %v", errs)
	}
	// acao do usuario: mensagem clara
	s.handle(c, clientRequest{Op: "send", PaneID: intp(3), Data: strp("x")}, e)
	s.handle(c, clientRequest{Op: "resize", PaneID: intp(3), Cols: intp(80), Rows: intp(24)}, e)
	if len(errs) != 2 || errs[0] != msgConnecting || errs[1] != msgConnecting {
		t.Fatalf("user actions => %v", errs)
	}
	// a ponte sobe: resync manda lista, watch e a rolagem guardada
	f := &scriptBridge{h: h}
	br.mu.Lock()
	br.stdin = f
	br.mu.Unlock()
	br.resync()
	f.mu.Lock()
	reqs := f.reqs
	f.mu.Unlock()
	var ops []string
	for _, r := range reqs {
		ops = append(ops, r["op"].(string))
	}
	if strings.Join(ops, ",") != "list,watch,scroll" || reqs[2]["offset"].(float64) != 40 {
		t.Fatalf("resync = %v", reqs)
	}
	// status "up" chega a quem ja' estava conectado
	h.setStatus("up", "conectado ao BethTerm")
	st := evs(drain(c, 50*time.Millisecond), "status")
	if len(st) == 0 || st[len(st)-1]["state"] != "up" {
		t.Fatalf("status = %v", st)
	}
}
