package vpsinstall

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

const testToken = "cf-token-SECRETO-123"

// fakeCF imita o trecho da API v4 que o assistente usa.
type fakeCF struct {
	mu       sync.Mutex
	srv      *httptest.Server
	records  []Record
	next     int
	denyDNS  bool
	denyZone bool
	status   string
	zones    []Zone
	calls    []string
}

func newFakeCF(t *testing.T) *fakeCF {
	f := &fakeCF{status: "active", zones: []Zone{{ID: "aaa111", Name: "exemplo.com", Status: "active"}}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeCF) api() CFAPI { return NewCloudflare(testToken, f.srv.URL, f.srv.Client()) }

func reply(w http.ResponseWriter, code int, result any, errs ...cfErrItem) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	b, _ := json.Marshal(result)
	body := map[string]any{"success": code < 300, "errors": errs, "result": json.RawMessage(b)}
	_ = json.NewEncoder(w).Encode(body)
}

func (f *fakeCF) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, r.Method+" "+r.URL.Path)
	if r.Header.Get("Authorization") != "Bearer "+testToken {
		reply(w, 401, nil, cfErrItem{9109, "Invalid access token"})
		return
	}
	p := r.URL.Path
	switch {
	case p == "/user/tokens/verify":
		reply(w, 200, map[string]string{"id": "x", "status": f.status})
	case p == "/zones":
		if f.denyZone {
			reply(w, 403, nil, cfErrItem{9109, "Unauthorized"})
			return
		}
		reply(w, 200, f.zones)
	case strings.HasPrefix(p, "/zones/") && !strings.Contains(strings.TrimPrefix(p, "/zones/"), "/"):
		id := strings.TrimPrefix(p, "/zones/")
		for _, z := range f.zones {
			if z.ID == id {
				reply(w, 200, z)
				return
			}
		}
		reply(w, 404, nil, cfErrItem{1003, "zone not found"})
	case strings.Contains(p, "/dns_records"):
		if f.denyDNS {
			reply(w, 403, nil, cfErrItem{10000, "Authentication error"})
			return
		}
		f.dns(w, r)
	default:
		reply(w, 404, nil, cfErrItem{7000, "no route"})
	}
}

func (f *fakeCF) dns(w http.ResponseWriter, r *http.Request) {
	idx := strings.Index(r.URL.Path, "/dns_records")
	id := strings.TrimPrefix(r.URL.Path[idx+len("/dns_records"):], "/")
	switch r.Method {
	case http.MethodGet:
		name := r.URL.Query().Get("name")
		out := []Record{}
		for _, rc := range f.records {
			if name == "" || rc.Name == name {
				out = append(out, rc)
			}
		}
		reply(w, 200, out)
	case http.MethodPost:
		var rc Record
		_ = json.NewDecoder(r.Body).Decode(&rc)
		f.next++
		rc.ID = fmt.Sprintf("%032x", f.next)
		f.records = append(f.records, rc)
		reply(w, 200, rc)
	case http.MethodPatch:
		var rc Record
		_ = json.NewDecoder(r.Body).Decode(&rc)
		for i := range f.records {
			if f.records[i].ID == id {
				rc.ID = id
				f.records[i] = rc
				reply(w, 200, rc)
				return
			}
		}
		reply(w, 404, nil, cfErrItem{81044, "Record does not exist"})
	case http.MethodDelete:
		for i := range f.records {
			if f.records[i].ID == id {
				f.records = append(f.records[:i], f.records[i+1:]...)
				reply(w, 200, map[string]string{"id": id})
				return
			}
		}
		reply(w, 404, nil, cfErrItem{81044, "Record does not exist"})
	}
}

func TestCFVerifyAndZones(t *testing.T) {
	f := newFakeCF(t)
	ctx := context.Background()
	if err := f.api().VerifyToken(ctx); err != nil {
		t.Fatal(err)
	}
	zs, err := f.api().ListZones(ctx)
	if err != nil || len(zs) != 1 || zs[0].Name != "exemplo.com" {
		t.Fatalf("%v %v", zs, err)
	}
	f.status = "expired"
	if err := f.api().VerifyToken(ctx); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("token expirado: %v", err)
	}
}

func TestCFTokenErrosNaoVazamToken(t *testing.T) {
	f := newFakeCF(t)
	ctx := context.Background()
	bad := NewCloudflare("outro-token-INVALIDO", f.srv.URL, f.srv.Client())
	err := bad.VerifyToken(ctx)
	if err == nil || strings.Contains(err.Error(), "INVALIDO") {
		t.Fatalf("erro: %v", err)
	}
	f.denyZone = true
	_, err = f.api().ListZones(ctx)
	if err == nil || !strings.Contains(err.Error(), "Zone → Zone → Read") || strings.Contains(err.Error(), testToken) {
		t.Fatalf("sem permissão de zona: %v", err)
	}
	f.denyDNS = true
	_, err = f.api().ListRecords(ctx, "aaa111", "a.exemplo.com")
	if err == nil || !strings.Contains(err.Error(), "DNS → Edit") {
		t.Fatalf("sem permissão de DNS: %v", err)
	}
}

func TestCFZonaInexistente(t *testing.T) {
	f := newFakeCF(t)
	_, err := f.api().GetZone(context.Background(), "bbb222")
	if err == nil || !strings.Contains(err.Error(), "não encontrou") {
		t.Fatalf("%v", err)
	}
	if _, err := f.api().GetZone(context.Background(), "../x"); err == nil {
		t.Fatal("id com caminho deveria ser recusado")
	}
}

func TestEnsureRecordCriaAtualizaIgual(t *testing.T) {
	f := newFakeCF(t)
	ctx := context.Background()
	api := f.api()
	o, err := EnsureRecord(ctx, api, "aaa111", "a.exemplo.com", "A", "203.0.113.9", false)
	if err != nil || o.Action != "criado" || o.RecordID == "" {
		t.Fatalf("%+v %v", o, err)
	}
	if f.records[0].Comment != WizardComment || f.records[0].Proxied {
		t.Fatalf("registro: %+v", f.records[0])
	}
	o2, err := EnsureRecord(ctx, api, "aaa111", "a.exemplo.com", "A", "203.0.113.9", false)
	if err != nil || o2.Action != "igual" || o2.RecordID != o.RecordID || len(f.records) != 1 {
		t.Fatalf("idempotência: %+v %v", o2, err)
	}
	o3, err := EnsureRecord(ctx, api, "aaa111", "a.exemplo.com", "A", "203.0.113.10", true)
	if err != nil || o3.Action != "atualizado" || o3.RecordID != o.RecordID || len(f.records) != 1 {
		t.Fatalf("atualização: %+v %v", o3, err)
	}
	if !f.records[0].Proxied || f.records[0].Content != "203.0.113.10" {
		t.Fatalf("%+v", f.records[0])
	}
}

func TestEnsureRecordNaoMexeNoAlheio(t *testing.T) {
	f := newFakeCF(t)
	f.records = []Record{{ID: "00ab", Type: "A", Name: "a.exemplo.com", Content: "198.51.100.1", TTL: 300}}
	_, err := EnsureRecord(context.Background(), f.api(), "aaa111", "a.exemplo.com", "A", "203.0.113.9", false)
	if err == nil || !strings.Contains(err.Error(), "não foi criado por este assistente") {
		t.Fatalf("%v", err)
	}
	if f.records[0].Content != "198.51.100.1" || len(f.records) != 1 {
		t.Fatal("registro alheio foi alterado")
	}
	f.records = []Record{{ID: "00ac", Type: "CNAME", Name: "a.exemplo.com", Content: "x.com"}}
	if _, err := EnsureRecord(context.Background(), f.api(), "aaa111", "a.exemplo.com", "A", "203.0.113.9", false); err == nil {
		t.Fatal("CNAME existente deveria parar")
	}
}

func TestRemoveWizardRecordsSoOsDoAssistente(t *testing.T) {
	f := newFakeCF(t)
	f.records = []Record{
		{ID: "01", Type: "A", Name: "a.exemplo.com", Content: "1.1.1.1", Comment: WizardComment},
		{ID: "02", Type: "A", Name: "a.exemplo.com", Content: "2.2.2.2"},
		{ID: "03", Type: "TXT", Name: "b.exemplo.com", Content: "x"},
	}
	n, err := RemoveWizardRecords(context.Background(), f.api(), "aaa111", "a.exemplo.com", []string{"01", "02"})
	if err != nil || n != 1 {
		t.Fatalf("%d %v", n, err)
	}
	if len(f.records) != 2 || f.records[0].ID != "02" {
		t.Fatalf("restaram %+v", f.records)
	}
}
