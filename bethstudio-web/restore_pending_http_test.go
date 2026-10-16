package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAdoptIdentityRestoresNameAndLook(t *testing.T) {
	st := &settingsStore{dir: t.TempDir()}
	st.s = webSettings{
		Panes:     map[string]*PaneAppearance{"8": {HostID: "x", Title: "de outro"}},
		PaneNames: map[string]*PaneName{},
	}
	name := &PaneName{Name: "arte-maior", HostID: "100@1"}
	look := &PaneAppearance{Appearance: Appearance{Theme: "tema-um"}, HostID: "100@1", Title: "arte-maior"}
	st.adoptIdentity(8, name, look, "200@2")
	if n := st.s.PaneNames["8"]; n == nil || n.Name != "arte-maior" || n.HostID != "200@2" {
		t.Fatalf("nome = %+v", n)
	}
	if p := st.s.Panes["8"]; p == nil || p.Theme != "tema-um" || p.HostID != "200@2" {
		t.Fatalf("aparência = %+v", p)
	}
	if name.HostID != "100@1" {
		t.Fatal("a cópia original não pode ser alterada")
	}
	st.adoptIdentity(9, nil, nil, "200@2") // nada a restaurar: não quebra
}

func pendingHTTP(t *testing.T, h http.Handler, body string) (int, map[string]any) {
	t.Helper()
	r := httptest.NewRequest("POST", "/api/restore/pending", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, r)
	var out map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	return rr.Code, out
}

func TestRestorePendingEndpoint(t *testing.T) {
	ph := newPendingHarness()
	hb := &hub{restore: &restoreCoordinator{}}
	hb.restore.holds.set(pendingFixture())
	handler := restorePendingHandler(hb, false, ph.deps)

	if code, _ := pendingHTTP(t, handler, `{"pane_id":99,"action":"retry"}`); code != http.StatusNotFound {
		t.Fatalf("id desconhecido = %d", code)
	}
	if code, _ := pendingHTTP(t, handler, `{"pane_id":3,"action":"dançar"}`); code != http.StatusBadRequest {
		t.Fatalf("ação inválida = %d", code)
	}
	code, out := pendingHTTP(t, handler, `{"pane_id":3,"action":"retry"}`)
	if code != 200 || out["opened"] != false {
		t.Fatalf("pasta ausente: %d %v", code, out)
	}
	ph.dirs["Debian|/mnt/kingston/mcu/repo/a"] = true
	code, out = pendingHTTP(t, handler, `{"pane_id":3,"action":"retry"}`)
	if code != 200 || out["opened"] != true {
		t.Fatalf("pasta presente: %d %v", code, out)
	}
	if code, _ := pendingHTTP(t, handler, `{"pane_id":4,"action":"discard"}`); code != 200 {
		t.Fatalf("discard = %d", code)
	}
	if left := hb.restore.holds.list(); len(left) != 0 {
		t.Fatalf("sobraram pendentes: %+v", left)
	}

	ro := restorePendingHandler(hb, true, ph.deps)
	if code, _ := pendingHTTP(t, ro, `{"pane_id":3,"action":"keep"}`); code != http.StatusForbidden {
		t.Fatalf("somente leitura = %d", code)
	}
	var nilCoord http.Handler = restorePendingHandler(&hub{}, false, ph.deps)
	if code, _ := pendingHTTP(t, nilCoord, `{"pane_id":3,"action":"keep"}`); code != http.StatusNotFound {
		t.Fatalf("sem coordenador = %d", code)
	}
	_ = context.Background
}
