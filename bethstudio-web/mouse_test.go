package main

import "testing"

func TestMouseMessage(t *testing.T) {
	p, x, y := 3, 10, 2
	m, err := mouseMessage(clientRequest{Op: "mouse", PaneID: &p, X: &x, Y: &y, Kind: "press", Button: "left", Ctrl: true})
	if err != nil {
		t.Fatal(err)
	}
	if m["op"] != "mouse" || m["pane_id"] != 3 || m["x"] != 10 || m["y"] != 2 || m["ctrl"] != true {
		t.Fatalf("mensagem errada: %v", m)
	}
	bad := []clientRequest{
		{PaneID: &p, X: &x, Y: &y, Kind: "click", Button: "left"},
		{PaneID: &p, X: &x, Y: &y, Kind: "press", Button: "x"},
		{PaneID: &p, Kind: "press", Button: "left"},
	}
	neg := -1
	bad = append(bad, clientRequest{PaneID: &p, X: &neg, Y: &y, Kind: "press", Button: "left"})
	for i, r := range bad {
		if _, err := mouseMessage(r); err == nil {
			t.Fatalf("caso %d deveria falhar", i)
		}
	}
}
