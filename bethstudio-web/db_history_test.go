package main

import (
	"fmt"
	"strings"
	"testing"
)

func newTestHistory(t *testing.T) *dbHistoryStore {
	return &dbHistoryStore{dir: t.TempDir(), lines: -1}
}

func TestDBHistoryAddAndSearch(t *testing.T) {
	st := newTestHistory(t)
	st.add(dbHistoryEntry{ConnID: "c1", ConnName: "clientes", Database: "acesso1", SQL: "SELECT * FROM tblmidias WHERE nome ILIKE '%maria%'", Rows: 69})
	st.add(dbHistoryEntry{ConnID: "c2", ConnName: "vendas", Database: "loja", SQL: "select count(*) from pedidos"})
	st.add(dbHistoryEntry{ConnID: "c1", ConnName: "clientes", Database: "acesso2", SQL: "select x from nada", Error: "relation does not exist"})
	st.add(dbHistoryEntry{ConnID: "c1", SQL: "   "}) // vazia: ignorada

	items, total, err := st.search(dbHistoryQuery{})
	if err != nil || total != 3 || len(items) != 3 {
		t.Fatalf("total=%d items=%d err=%v", total, len(items), err)
	}
	if !strings.Contains(items[0].SQL, "nada") { // mais recente primeiro
		t.Fatalf("ordem: %q", items[0].SQL)
	}

	// busca por termos, sem diferenciar maiúsculas, também no nome da conexão e no banco
	for q, want := range map[string]int{"MARIA": 1, "tblmidias maria": 1, "pedidos": 1, "vendas": 1, "acesso": 2, "select": 3, "inexistente": 0} {
		if _, n, _ := st.search(dbHistoryQuery{Q: q}); n != want {
			t.Errorf("q=%q total=%d, quer %d", q, n, want)
		}
	}
	if _, n, _ := st.search(dbHistoryQuery{ConnID: "c1"}); n != 2 {
		t.Errorf("filtro de conexão: %d", n)
	}
	if it, n, _ := st.search(dbHistoryQuery{Failed: true}); n != 1 || it[0].Error == "" {
		t.Errorf("só com erro: %d", n)
	}
}

func TestDBHistoryPagingRemoveClear(t *testing.T) {
	st := newTestHistory(t)
	for i := 0; i < 7; i++ {
		st.add(dbHistoryEntry{ConnID: "c", SQL: fmt.Sprintf("select %d", i)})
	}
	page, total, _ := st.search(dbHistoryQuery{Limit: 3, Offset: 2})
	if total != 7 || len(page) != 3 || page[0].SQL != "select 4" {
		t.Fatalf("página: total=%d %v", total, page)
	}
	if err := st.remove(page[0].ID); err != nil {
		t.Fatal(err)
	}
	if _, n, _ := st.search(dbHistoryQuery{}); n != 6 {
		t.Fatalf("depois de apagar: %d", n)
	}
	if err := st.clear(); err != nil {
		t.Fatal(err)
	}
	if _, n, _ := st.search(dbHistoryQuery{}); n != 0 {
		t.Fatalf("depois de limpar: %d", n)
	}
	st.add(dbHistoryEntry{ConnID: "c", SQL: "select 1"})
	if _, n, _ := st.search(dbHistoryQuery{}); n != 1 {
		t.Fatalf("grava de novo depois de limpar: %d", n)
	}
}

func TestDBHistoryTrimsOldEntries(t *testing.T) {
	st := newTestHistory(t)
	for i := 0; i < dbHistoryKeep+dbHistorySlack+5; i++ {
		st.add(dbHistoryEntry{ConnID: "c", SQL: fmt.Sprintf("select %d", i)})
	}
	items, total, _ := st.search(dbHistoryQuery{Limit: 1})
	if total > dbHistoryKeep+dbHistorySlack || total < dbHistoryKeep {
		t.Fatalf("total=%d", total)
	}
	if items[0].SQL != fmt.Sprintf("select %d", dbHistoryKeep+dbHistorySlack+4) {
		t.Fatalf("a mais recente sumiu: %q", items[0].SQL)
	}
}
