package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestDBSimpleSelectTable(t *testing.T) {
	cases := []struct {
		d             dbDriver
		sql           string
		schema, table string
		ok            bool
	}{
		{dbPostgres, `SELECT * FROM clientconfig WHERE clienteid=4597`, "", "clientconfig", true},
		{dbPostgres, `SELECT * FROM public.clientconfig WHERE x = 1`, "public", "clientconfig", true},
		{dbPostgres, `select a, b from "Clientes"`, "", "Clientes", true},
		{dbPostgres, `SELECT * FROM t AS c WHERE id = 1`, "", "t", true},
		{dbPostgres, `SELECT * FROM t ORDER BY id LIMIT 10`, "", "t", true},
		{dbSQLite, `SELECT id, nome FROM clientes WHERE nome = 'Ana'`, "", "clientes", true},
		{dbPostgres, `SELECT * FROM t JOIN u ON t.id = u.id`, "", "", false},
		{dbPostgres, `SELECT * FROM t, u`, "", "", false},
		{dbPostgres, `WITH c AS (SELECT 1) SELECT * FROM c`, "", "", false},
		{dbPostgres, `SELECT * FROM t GROUP BY id`, "", "", false},
		{dbPostgres, `INSERT INTO t (a) VALUES (1)`, "", "", false},
	}
	for _, c := range cases {
		schema, table, ok := dbSimpleSelectTable(c.d, c.sql)
		if schema != c.schema || table != c.table || ok != c.ok {
			t.Errorf("%s: got schema=%q table=%q ok=%v", c.sql, schema, table, ok)
		}
	}
}

func TestDBUpdateCell(t *testing.T) {
	s, dir, _ := dbTestEnv(t, false)
	file := filepath.Join(dir, "edit.db")
	id := saveConn(t, s, map[string]any{"name": "edit", "driver": "sqlite", "file": file, "create_file": true}, nil)
	dbRunConfirmed(t, s, id, `CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT NOT NULL, cidade TEXT, foto BLOB);
CREATE TABLE log (msg TEXT);
INSERT INTO clientes (nome, cidade) VALUES ('Ana', 'Recife');
INSERT INTO log (msg) VALUES ('oi')`)

	code, m, raw := dbCall(t, s, "POST", "/api/db/query", map[string]any{
		"id": id, "query_id": "sel", "sql": "SELECT * FROM clientes WHERE nome = 'Ana'",
	})
	mustOK(t, code, m, raw)
	rs := results(t, m)
	edit, _ := rs[0]["edit"].(map[string]any)
	if edit == nil || edit["schema"] != "main" || edit["table"] != "clientes" {
		t.Fatalf("SELECT simples deveria ser editável: %s", raw)
	}
	pk, _ := edit["pk"].([]any)
	if len(pk) != 1 || pk[0] != "id" {
		t.Fatalf("chave: %v", edit["pk"])
	}
	row := rs[0]["rows"].([]any)[0].([]any)
	rowID := row[0]

	code, m, raw = dbCall(t, s, "POST", "/api/db/query", map[string]any{
		"id": id, "query_id": "join", "sql": "SELECT * FROM clientes c JOIN log ON 1 = 1",
	})
	mustOK(t, code, m, raw)
	if _, ok := results(t, m)[0]["edit"]; ok {
		t.Fatalf("JOIN não deve ser editável: %s", raw)
	}

	code, m, raw = dbCall(t, s, "POST", "/api/db/row", map[string]any{
		"id": id, "schema": "main", "table": "clientes", "column": "cidade", "value": "Olinda",
		"where": map[string]any{"id": rowID},
	})
	mustOK(t, code, m, raw)
	if m["affected"] != float64(1) {
		t.Fatalf("affected: %v", m["affected"])
	}
	_, m, _ = dbCall(t, s, "POST", "/api/db/query", map[string]any{
		"id": id, "query_id": "back", "sql": "SELECT cidade FROM clientes WHERE nome = 'Ana'",
	})
	if got := results(t, m)[0]["rows"].([]any)[0].([]any)[0]; got != "Olinda" {
		t.Fatalf("cidade depois do update: %v", got)
	}

	code, m, raw = dbCall(t, s, "POST", "/api/db/row", map[string]any{
		"id": id, "schema": "main", "table": "clientes", "column": "cidade", "value": "Recife",
		"where": map[string]any{"id": 99999},
	})
	if code == 200 || !strings.Contains(m["error"].(string), "nenhuma linha") {
		t.Fatalf("chave errada: %d %s", code, raw)
	}
	_, m, _ = dbCall(t, s, "POST", "/api/db/query", map[string]any{
		"id": id, "query_id": "still", "sql": "SELECT cidade FROM clientes WHERE nome = 'Ana'",
	})
	if got := results(t, m)[0]["rows"].([]any)[0].([]any)[0]; got != "Olinda" {
		t.Fatalf("chave errada alterou a linha: %v", got)
	}

	code, _, raw = dbCall(t, s, "POST", "/api/db/row", map[string]any{
		"id": id, "schema": "main", "table": "clientes", "column": "nao_existe", "value": "x",
		"where": map[string]any{"id": rowID},
	})
	if code != 400 || !strings.Contains(raw, "desconhecida") {
		t.Fatalf("coluna desconhecida: %d %s", code, raw)
	}
	code, _, raw = dbCall(t, s, "POST", "/api/db/row", map[string]any{
		"id": id, "schema": "main", "table": "clientes", "column": "nome", "null": true,
		"where": map[string]any{"id": rowID},
	})
	if code != 400 || !strings.Contains(raw, "NULL") {
		t.Fatalf("NULL em NOT NULL: %d %s", code, raw)
	}
	code, _, raw = dbCall(t, s, "POST", "/api/db/row", map[string]any{
		"id": id, "schema": "main", "table": "clientes", "column": "foto", "value": "aa",
		"where": map[string]any{"id": rowID},
	})
	if code != 400 || !strings.Contains(raw, "binária") {
		t.Fatalf("blob: %d %s", code, raw)
	}
	code, _, raw = dbCall(t, s, "POST", "/api/db/row", map[string]any{
		"id": id, "schema": "main", "table": "log", "column": "msg", "value": "x",
		"where": map[string]any{"msg": "oi"},
	})
	if code != 400 || !strings.Contains(raw, "chave primária") {
		t.Fatalf("sem chave: %d %s", code, raw)
	}

	ro := saveConn(t, s, map[string]any{"name": "ro", "driver": "sqlite", "file": file, "read_only": true}, nil)
	code, _, raw = dbCall(t, s, "POST", "/api/db/row", map[string]any{
		"id": ro, "schema": "main", "table": "clientes", "column": "cidade", "value": "X",
		"where": map[string]any{"id": rowID},
	})
	if code != 403 {
		t.Fatalf("somente leitura: %d %s", code, raw)
	}
}

func TestDBSelectSources(t *testing.T) {
	s, ok := dbSelectSources(dbPostgres, `SELECT DISTINCT c.id, nome AS apelido, upper(cidade) AS cidade, count(*), c.* FROM clientes c`)
	if !ok || !s.star || s.plain["id"] != "id" || s.plain["apelido"] != "nome" || !s.computed["cidade"] {
		t.Fatalf("%+v ok=%v", s, ok)
	}
	if s, ok := dbSelectSources(dbSQLServer, `SELECT TOP (10) [Id], Nome n FROM t`); !ok || s.plain["id"] != "id" || s.plain["n"] != "nome" {
		t.Fatalf("sqlserver: %+v ok=%v", s, ok)
	}
	if _, ok := dbSelectSources(dbPostgres, `SELECT DISTINCT ON (a) * FROM t`); ok {
		t.Fatal("DISTINCT ON escolhe uma linha por grupo")
	}
}

// A grade só edita coluna que vem direto da tabela, e só usa como chave a
// chave de verdade: "SELECT nome AS id" gravaria na linha errada.
func TestDBEditOnlyDirectColumns(t *testing.T) {
	s, dir, _ := dbTestEnv(t, false)
	file := filepath.Join(dir, "direct.db")
	id := saveConn(t, s, map[string]any{"name": "direct", "driver": "sqlite", "file": file, "create_file": true}, nil)
	dbRunConfirmed(t, s, id, `CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT, cidade TEXT);
INSERT INTO clientes (nome, cidade) VALUES ('Ana', 'Recife'), ('Bia', 'Natal')`)
	editOf := func(q string) map[string]any {
		t.Helper()
		code, m, raw := dbCall(t, s, "POST", "/api/db/query", map[string]any{"id": id, "query_id": "q", "sql": q})
		mustOK(t, code, m, raw)
		e, _ := results(t, m)[0]["edit"].(map[string]any)
		return e
	}
	cols := func(e map[string]any) string {
		var out []string
		for _, c := range e["columns"].([]any) {
			out = append(out, c.(string))
		}
		return strings.Join(out, ",")
	}
	for _, q := range []string{
		`SELECT nome AS id FROM clientes`,
		`SELECT max(id) AS id FROM clientes`,
		`SELECT id + 1 AS id, nome FROM clientes`,
	} {
		if e := editOf(q); e != nil {
			t.Fatalf("%s: não devia editar: %v", q, e)
		}
	}
	if e := editOf(`SELECT id, upper(nome) AS nome, cidade FROM clientes`); e == nil || cols(e) != "id,cidade" {
		t.Fatalf("expressão não é editável: %v", e)
	}
	if e := editOf(`SELECT * FROM clientes`); e == nil || cols(e) != "id,nome,cidade" {
		t.Fatalf("*: %v", e)
	}
	if e := editOf(`SELECT c.id, c.nome FROM clientes c WHERE c.id = 1`); e == nil || cols(e) != "id,nome" {
		t.Fatalf("t.col: %v", e)
	}
}

// DECIMAL/NUMERIC/MONEY vão como texto exato (float64 arredondaria), e a
// data do MySQL perde o "T" e o fuso que o modo estrito recusa.
func TestDBCoerceCellExactAndMySQLTime(t *testing.T) {
	cases := []struct {
		d    dbDriver
		typ  string
		in   any
		want any
	}{
		{dbPostgres, "NUMERIC(20,2)", "123456789012345678.91", "123456789012345678.91"},
		{dbSQLServer, "MONEY", " 922337203685477.5807 ", "922337203685477.5807"},
		{dbMySQL, "DECIMAL(10,2)", int64(42), "42"},
		{dbMySQL, "DATETIME", "2026-09-30T12:34:56.123456Z", "2026-09-30 12:34:56.123456"},
		{dbMySQL, "TIMESTAMP", "2026-09-30T12:34:56-03:00", "2026-09-30 12:34:56"},
		{dbPostgres, "TIMESTAMP", "2026-09-30T12:34:56Z", "2026-09-30T12:34:56Z"},
		{dbPostgres, "INTEGER", "7", int64(7)},
	}
	for _, c := range cases {
		got, err := dbCoerceCell(c.d, c.typ, c.in)
		if err != nil || got != c.want {
			t.Errorf("%s %s %v: %v (%v), queria %v", c.d, c.typ, c.in, got, err, c.want)
		}
	}
	if _, err := dbCoerceCell(dbPostgres, "DECIMAL", "12,5"); err == nil {
		t.Error("vírgula decimal devia ser recusada")
	}
}
