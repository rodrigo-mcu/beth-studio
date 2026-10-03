package main

// End-to-end tests of the database panel against SQLite files created in a
// temporary folder. No server of any kind is contacted.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type memDBSecrets struct {
	mu sync.Mutex
	m  map[string]string
}

func (m *memDBSecrets) get(k string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.m[k]
}

func (m *memDBSecrets) set(k, v string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if v == "" {
		delete(m.m, k)
	} else {
		m.m[k] = v
	}
	return nil
}

// dbTestEnv swaps the global store for one in a temp dir with memory secrets.
func dbTestEnv(t *testing.T, appReadOnly bool) (*server, string, *memDBSecrets) {
	t.Helper()
	dir := t.TempDir()
	mem := &memDBSecrets{m: map[string]string{}}
	old := dbConns
	dbConns = &dbConnStore{dir: dir, secret: mem, onChange: dbPools.drop}
	t.Cleanup(func() {
		for _, c := range dbConns.conns {
			dbPools.drop(c.ID)
		}
		dbConns = old
	})
	return &server{hub: newHub(appReadOnly)}, dir, mem
}

func dbCall(t *testing.T, s *server, method, path string, body any) (int, map[string]any, string) {
	t.Helper()
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, rd)
	rec := httptest.NewRecorder()
	s.serveDB(rec, req)
	raw := rec.Body.String()
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("%s %s: resposta não é JSON: %s", method, path, raw)
	}
	return rec.Code, m, raw
}

func mustOK(t *testing.T, code int, m map[string]any, raw string) {
	t.Helper()
	if code != http.StatusOK {
		t.Fatalf("HTTP %d: %s", code, raw)
	}
	if e, _ := m["error"].(string); e != "" {
		t.Fatalf("erro: %s", e)
	}
}

// dbRunConfirmed runs a script, confirming it when the server asks.
func dbRunConfirmed(t *testing.T, s *server, id, sqlText string) map[string]any {
	t.Helper()
	body := map[string]any{"id": id, "sql": sqlText, "query_id": fmt.Sprintf("q%d", time.Now().UnixNano())}
	code, m, raw := dbCall(t, s, "POST", "/api/db/query", body)
	if code != 200 {
		t.Fatalf("HTTP %d: %s", code, raw)
	}
	if m["needs_confirm"] == true {
		body["confirm"] = m["confirm_token"]
		body["query_id"] = fmt.Sprintf("q%d", time.Now().UnixNano())
		code, m, raw = dbCall(t, s, "POST", "/api/db/query", body)
		if code != 200 {
			t.Fatalf("HTTP %d: %s", code, raw)
		}
	}
	return m
}

func results(t *testing.T, m map[string]any) []map[string]any {
	t.Helper()
	arr, _ := m["results"].([]any)
	var out []map[string]any
	for _, r := range arr {
		out = append(out, r.(map[string]any))
	}
	return out
}

func saveConn(t *testing.T, s *server, conn map[string]any, password *string) string {
	t.Helper()
	body := map[string]any{"connection": conn}
	if password != nil {
		body["password"] = *password
	}
	code, m, raw := dbCall(t, s, "POST", "/api/db/connections/save", body)
	mustOK(t, code, m, raw)
	return m["connection"].(map[string]any)["id"].(string)
}

func TestDBSQLiteEndToEnd(t *testing.T) {
	s, dir, _ := dbTestEnv(t, false)
	file := filepath.Join(dir, "loja de teste.db")

	// test before the file exists: no side effect
	code, m, raw := dbCall(t, s, "POST", "/api/db/test", map[string]any{"connection": map[string]any{
		"name": "x", "driver": "sqlite", "file": file, "create_file": true}})
	mustOK(t, code, m, raw)
	if _, err := os.Stat(file); err == nil {
		t.Fatal("o teste de conexão criou o arquivo")
	}

	id := saveConn(t, s, map[string]any{"name": "Loja", "group": "Testes", "driver": "sqlite", "file": file, "create_file": true, "color": "#3366FF"}, nil)

	// DDL + inserts need confirmation
	script := `CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT NOT NULL, cidade TEXT, saldo REAL DEFAULT 0, foto BLOB);
CREATE INDEX ix_cidade ON clientes(cidade);
CREATE VIEW v_sp AS SELECT * FROM clientes WHERE cidade = 'São Paulo';`
	code, m, raw = dbCall(t, s, "POST", "/api/db/query", map[string]any{"id": id, "sql": script, "query_id": "a1"})
	if code != 200 || m["needs_confirm"] != true {
		t.Fatalf("DDL sem confirmação deveria pedir confirmação: %s", raw)
	}
	if n := len(m["statements"].([]any)); n != 3 {
		t.Fatalf("esperava 3 instruções a confirmar, veio %d", n)
	}
	// a wrong token is not accepted
	code, m, raw = dbCall(t, s, "POST", "/api/db/query", map[string]any{"id": id, "sql": script, "query_id": "a2", "confirm": "errado"})
	if m["needs_confirm"] != true {
		t.Fatalf("token errado aceito: %s", raw)
	}
	m = dbRunConfirmed(t, s, id, script)
	if e, _ := m["error"].(string); e != "" {
		t.Fatalf("DDL: %s", e)
	}

	var ins strings.Builder
	ins.WriteString("INSERT INTO clientes (nome, cidade, saldo, foto) VALUES ")
	for i := 1; i <= 2500; i++ {
		if i > 1 {
			ins.WriteString(",")
		}
		cidade := []string{"São Paulo", "Recife", "Curitiba", "Belém"}[i%4]
		fmt.Fprintf(&ins, "('Cliente %04d', '%s', %d.5, X'00FF%02X')", i, cidade, i, i%256)
	}
	m = dbRunConfirmed(t, s, id, ins.String())
	rs := results(t, m)
	if len(rs) != 1 || rs[0]["affected"] != float64(2500) {
		t.Fatalf("insert: %v", m)
	}

	// dangerous statement is flagged
	code, m, raw = dbCall(t, s, "POST", "/api/db/query", map[string]any{"id": id, "sql": "UPDATE clientes SET saldo = 0", "query_id": "d1"})
	if m["needs_confirm"] != true || m["danger"] != true {
		t.Fatalf("UPDATE sem WHERE deveria ser perigoso: %s", raw)
	}

	// multiple result sets, row cap and load more
	code, m, raw = dbCall(t, s, "POST", "/api/db/query", map[string]any{"id": id, "query_id": "r1", "max_rows": 1000,
		"sql": "SELECT count(*) AS n FROM clientes; SELECT cidade, count(*) AS n FROM clientes GROUP BY cidade ORDER BY cidade; SELECT id, nome, foto FROM clientes ORDER BY id"})
	mustOK(t, code, m, raw)
	rs = results(t, m)
	if len(rs) != 3 {
		t.Fatalf("esperava 3 conjuntos de resultado: %s", raw)
	}
	if rs[0]["rows"].([]any)[0].([]any)[0] != float64(2500) {
		t.Fatalf("count: %v", rs[0]["rows"])
	}
	if len(rs[1]["rows"].([]any)) != 4 {
		t.Fatalf("group by: %v", rs[1]["rows"])
	}
	last := rs[2]
	if len(last["rows"].([]any)) != 1000 || last["has_more"] != true || last["more_id"] == nil {
		t.Fatalf("limite de linhas / carregar mais: rows=%d has_more=%v", len(last["rows"].([]any)), last["has_more"])
	}
	firstRow := last["rows"].([]any)[0].([]any)
	if firstRow[1] != "Cliente 0001" || firstRow[2] != "0x00FF01" {
		t.Fatalf("valores: %v", firstRow)
	}
	moreID := last["more_id"].(string)
	seen := 1000
	for {
		code, m, raw = dbCall(t, s, "POST", "/api/db/more", map[string]any{"more_id": moreID, "max_rows": 700})
		mustOK(t, code, m, raw)
		rows := m["rows"].([]any)
		if len(rows) > 0 {
			want := fmt.Sprintf("Cliente %04d", seen+1)
			if got := rows[0].([]any)[1]; got != want {
				t.Fatalf("carregar mais pulou/repetiu linha: %v, esperava %s", got, want)
			}
		}
		seen += len(rows)
		if m["has_more"] != true {
			break
		}
	}
	if seen != 2500 {
		t.Fatalf("carregar mais: %d linhas no total", seen)
	}
	if dbCursors.count() != 0 {
		t.Fatalf("cursor não foi fechado")
	}

	// schema browser
	code, m, raw = dbCall(t, s, "POST", "/api/db/schemas", map[string]any{"id": id})
	mustOK(t, code, m, raw)
	if fmt.Sprint(m["schemas"]) != "[main]" {
		t.Fatalf("schemas: %s", raw)
	}
	code, m, raw = dbCall(t, s, "POST", "/api/db/objects", map[string]any{"id": id, "schema": "main"})
	mustOK(t, code, m, raw)
	objs := m["objects"].([]any)
	if len(objs) != 2 || objs[0].(map[string]any)["name"] != "clientes" || objs[1].(map[string]any)["type"] != "view" {
		t.Fatalf("objetos: %s", raw)
	}
	if _, ok := m["routines"].([]any); !ok {
		t.Fatalf("rotinas: %s", raw)
	}
	code, m, raw = dbCall(t, s, "POST", "/api/db/columns", map[string]any{"id": id, "schema": "main", "table": "clientes"})
	mustOK(t, code, m, raw)
	cols := m["columns"].([]any)
	if len(cols) != 5 || cols[0].(map[string]any)["pk"] != true || cols[1].(map[string]any)["nullable"] != false {
		t.Fatalf("colunas: %s", raw)
	}
	idx := m["indexes"].([]any)
	if len(idx) != 1 || idx[0].(map[string]any)["name"] != "ix_cidade" {
		t.Fatalf("índices: %s", raw)
	}

	// ANALYZE fills sqlite_stat1, then objects carry an estimate
	dbRunConfirmed(t, s, id, "ANALYZE")
	_, m, _ = dbCall(t, s, "POST", "/api/db/objects", map[string]any{"id": id, "schema": "main"})
	if est := m["objects"].([]any)[0].(map[string]any)["rows_estimate"]; est != float64(2500) {
		t.Fatalf("estimativa de linhas: %v", est)
	}

	// table view: filter + sort + paging + count
	code, m, raw = dbCall(t, s, "POST", "/api/db/table", map[string]any{
		"id": id, "schema": "main", "table": "clientes", "limit": 50, "offset": 10, "count": true,
		"sort":    []map[string]any{{"column": "saldo", "desc": true}},
		"filters": []map[string]any{{"column": "cidade", "op": "eq", "value": "Recife"}, {"column": "nome", "op": "contains", "value": "Cliente 1"}},
	})
	mustOK(t, code, m, raw)
	// Recife = i%4==1; names containing "Cliente 1" = 1000..1999 plus 0001..0199 region etc.
	if m["total"] == nil || len(m["rows"].([]any)) != 50 || m["has_more"] != true {
		t.Fatalf("tabela: total=%v rows=%d has_more=%v", m["total"], len(m["rows"].([]any)), m["has_more"])
	}
	prev := 1e18
	for _, r := range m["rows"].([]any) {
		row := r.([]any)
		if row[2] != "Recife" || !strings.Contains(row[1].(string), "Cliente 1") {
			t.Fatalf("filtro falhou: %v", row)
		}
		if v := row[3].(float64); v > prev {
			t.Fatalf("ordenação falhou")
		} else {
			prev = v
		}
	}
	// LIKE wildcards in the value are literal
	_, m, _ = dbCall(t, s, "POST", "/api/db/table", map[string]any{"id": id, "schema": "main", "table": "clientes", "count": true,
		"filters": []map[string]any{{"column": "nome", "op": "contains", "value": "%"}}})
	if m["total"] != float64(0) {
		t.Fatalf("%% deveria ser literal: %v", m["total"])
	}
	// SQL in a column name is refused
	code, _, raw = dbCall(t, s, "POST", "/api/db/table", map[string]any{"id": id, "schema": "main", "table": "clientes",
		"sort": []map[string]any{{"column": "id; DROP TABLE clientes"}}})
	if code != 400 {
		t.Fatalf("coluna inválida aceita: %s", raw)
	}

	// cancel a long query
	done := make(chan map[string]any, 1)
	go func() {
		_, m, _ := dbCall(t, s, "POST", "/api/db/query", map[string]any{"id": id, "query_id": "longa",
			"sql": "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c"})
		done <- m
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, cm, _ := dbCall(t, s, "POST", "/api/db/cancel", map[string]any{"query_id": "longa"})
		if cm["cancelled"] == true {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("a consulta longa não apareceu para cancelar")
		}
		time.Sleep(20 * time.Millisecond)
	}
	select {
	case m = <-done:
		if m["error"] != "consulta cancelada" {
			t.Fatalf("cancelamento: %v", m["error"])
		}
	case <-time.After(10 * time.Second):
		t.Fatal("cancelar não interrompeu a consulta")
	}

	// timeout
	_, m, _ = dbCall(t, s, "POST", "/api/db/query", map[string]any{"id": id, "query_id": "to", "timeout_s": 1,
		"sql": "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c"})
	if e, _ := m["error"].(string); !strings.Contains(e, "tempo limite de 1 s") {
		t.Fatalf("timeout: %v", m["error"])
	}
	if ms, _ := m["elapsed_ms"].(float64); ms < 900 || ms > 5000 {
		t.Fatalf("tempo total informado: %v ms", m["elapsed_ms"])
	}

	// a failing statement keeps earlier results and says which one failed
	_, m, _ = dbCall(t, s, "POST", "/api/db/query", map[string]any{"id": id, "query_id": "e1",
		"sql": "SELECT 1 AS um; SELECT * FROM nao_existe"})
	if len(results(t, m)) != 1 || m["error_statement"] != float64(1) || !strings.Contains(m["error"].(string), "nao_existe") {
		t.Fatalf("erro parcial: %v", m)
	}
}

func TestDBSQLiteReadOnly(t *testing.T) {
	s, dir, _ := dbTestEnv(t, false)
	file := filepath.Join(dir, "ro.db")
	rw := saveConn(t, s, map[string]any{"name": "rw", "driver": "sqlite", "file": file, "create_file": true}, nil)
	dbRunConfirmed(t, s, rw, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('a'), ('b')")

	ro := saveConn(t, s, map[string]any{"name": "ro", "driver": "sqlite", "file": file, "read_only": true}, nil)
	for _, q := range []string{"DELETE FROM t WHERE id = 1", "DROP TABLE t", "PRAGMA journal_mode = DELETE", "BEGIN", "SELECT 1; UPDATE t SET v = 'x' WHERE id = 1"} {
		code, m, raw := dbCall(t, s, "POST", "/api/db/query", map[string]any{"id": ro, "sql": q, "query_id": "ro1", "confirm": dbConfirmToken(ro, "", q)})
		if code != 200 || m["blocked"] == nil || m["read_only"] != true {
			t.Fatalf("somente leitura aceitou %q: %s", q, raw)
		}
	}
	code, m, raw := dbCall(t, s, "POST", "/api/db/query", map[string]any{"id": ro, "sql": "SELECT count(*) FROM t", "query_id": "ro2"})
	mustOK(t, code, m, raw)
	if m["rolled_back"] != true || results(t, m)[0]["rows"].([]any)[0].([]any)[0] != float64(2) {
		t.Fatalf("leitura em conexão somente leitura: %s", raw)
	}

	// Second line of defence: even if the classifier missed a write, the
	// database refuses it (mode=ro + query_only + read-only transaction).
	cfg, pw, err := dbConns.get(ro)
	if err != nil {
		t.Fatal(err)
	}
	db, err := dbPools.get(t.Context(), cfg, pw, "")
	if err != nil {
		t.Fatal(err)
	}
	out := dbRunScript(t.Context(), db, dbSQLite, []dbStatement{{SQL: "DELETE FROM t", Kind: dbKindRead, ReturnsRows: false}},
		dbQueryOpts{QueryID: "bypass", MaxRows: 10, Timeout: 5 * time.Second, ReadOnly: true})
	if !strings.Contains(out.Error, "somente leitura") {
		t.Fatalf("o banco deveria recusar a escrita: %q", out.Error)
	}
	_, m, _ = dbCall(t, s, "POST", "/api/db/query", map[string]any{"id": rw, "sql": "SELECT count(*) FROM t", "query_id": "ro3"})
	if results(t, m)[0]["rows"].([]any)[0].([]any)[0] != float64(2) {
		t.Fatal("dados mudaram numa conexão somente leitura")
	}

	// app-wide --read-only makes every connection read-only
	s2 := &server{hub: newHub(true)}
	_, m, raw = dbCall(t, s2, "POST", "/api/db/query", map[string]any{"id": rw, "sql": "DELETE FROM t WHERE id = 1", "query_id": "ro4"})
	if m["blocked"] == nil || !strings.Contains(m["error"].(string), "modo somente leitura") {
		t.Fatalf("--read-only: %s", raw)
	}
}

func TestDBConnectionStore(t *testing.T) {
	s, dir, mem := dbTestEnv(t, false)
	pw := "s3nh@-secreta!"
	id := saveConn(t, s, map[string]any{"name": "PG local", "group": "Lab", "driver": "postgres", "host": "127.0.0.1", "user": "app", "database": "app"}, &pw)

	code, m, raw := dbCall(t, s, "GET", "/api/db/connections", nil)
	mustOK(t, code, m, raw)
	if strings.Contains(raw, pw) {
		t.Fatal("a senha voltou para a página")
	}
	c := m["connections"].([]any)[0].(map[string]any)
	if c["has_password"] != true || c["port"] != float64(5432) || c["ssl_mode"] != "prefer" {
		t.Fatalf("view: %s", raw)
	}
	b, _ := os.ReadFile(filepath.Join(dir, dbConnectionsFile))
	if strings.Contains(string(b), pw) || !strings.Contains(string(b), "PG local") {
		t.Fatalf("arquivo de conexões: %s", b)
	}
	if mem.get(dbSecretKey(id)) != pw {
		t.Fatal("a senha não foi para o cofre")
	}

	// edit without password keeps it; clear removes it
	saveConn(t, s, map[string]any{"id": id, "name": "PG local 2", "driver": "postgres", "host": "localhost"}, nil)
	if mem.get(dbSecretKey(id)) != pw {
		t.Fatal("editar sem senha apagou a senha")
	}
	code, m, raw = dbCall(t, s, "POST", "/api/db/connections/save", map[string]any{"id": id,
		"connection": map[string]any{"id": id, "name": "PG local 2", "driver": "postgres", "host": "localhost"}, "clear_password": true})
	mustOK(t, code, m, raw)
	if mem.get(dbSecretKey(id)) != "" {
		t.Fatal("a senha não foi apagada")
	}

	// validation
	bad := []map[string]any{
		{"name": "", "driver": "postgres", "host": "h"},
		{"name": "x", "driver": "oracle", "host": "h"},
		{"name": "x", "driver": "postgres", "host": "h; rm"},
		{"name": "x", "driver": "postgres", "host": "h", "port": 70000},
		{"name": "x", "driver": "postgres", "host": "h", "ssl_mode": "sometimes"},
		{"name": "x", "driver": "sqlite", "file": "relativo.db"},
		{"name": "x", "driver": "sqlite", "file": `C:\a?b.db`},
		{"name": "x", "driver": "mysql", "host": "h", "color": "red"},
	}
	for _, b := range bad {
		code, _, raw := dbCall(t, s, "POST", "/api/db/connections/save", map[string]any{"connection": b})
		if code != 400 {
			t.Errorf("aceitou %v: %s", b, raw)
		}
	}

	// tunnel field without a provider gives a clear error, not a direct connection
	tid := saveConn(t, s, map[string]any{"name": "via ssh", "driver": "mysql", "host": "10.0.0.5", "tunnel": "bastion"}, nil)
	_, m, _ = dbCall(t, s, "POST", "/api/db/test", map[string]any{"id": tid})
	if m["ok"] != false || !strings.Contains(fmt.Sprint(m["error"]), "túnel SSH") {
		t.Fatalf("túnel: %v", m)
	}

	// delete removes the entry and the password
	code, m, raw = dbCall(t, s, "POST", "/api/db/connections/delete", map[string]any{"id": id})
	mustOK(t, code, m, raw)
	_, m, _ = dbCall(t, s, "GET", "/api/db/connections", nil)
	if len(m["connections"].([]any)) != 1 {
		t.Fatalf("apagar: %v", m)
	}
}

func TestDBSecretScrub(t *testing.T) {
	err := dbScrubErr(fmt.Errorf("falhou: postgres://u:p%%40ss@h/db"), "p@ss")
	if strings.Contains(err.Error(), "p%40ss") {
		t.Fatalf("senha codificada no erro: %v", err)
	}
	err = dbScrubErr(fmt.Errorf("senha minhasenha errada"), "minhasenha")
	if strings.Contains(err.Error(), "minhasenha") {
		t.Fatalf("senha no erro: %v", err)
	}
}
