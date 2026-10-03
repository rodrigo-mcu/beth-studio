package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestDBApplyRows(t *testing.T) {
	s, dir, _ := dbTestEnv(t, false)
	file := filepath.Join(dir, "apply.db")
	id := saveConn(t, s, map[string]any{"name": "apply", "driver": "sqlite", "file": file, "create_file": true}, nil)
	dbRunConfirmed(t, s, id, `CREATE TABLE c (id INTEGER PRIMARY KEY, nome TEXT NOT NULL, cidade TEXT DEFAULT 'Recife');
INSERT INTO c (id, nome) VALUES (1, 'Ana'), (2, 'Bia'), (3, 'Caio')`)
	names := func() string {
		code, m, raw := dbCall(t, s, "POST", "/api/db/query", map[string]any{"id": id, "query_id": "n", "sql": "SELECT id || ':' || nome || ':' || coalesce(cidade, '-') FROM c ORDER BY id"})
		mustOK(t, code, m, raw)
		var out []string
		for _, r := range results(t, m)[0]["rows"].([]any) {
			out = append(out, r.([]any)[0].(string))
		}
		return strings.Join(out, " ")
	}
	apply := func(body map[string]any) map[string]any {
		t.Helper()
		body["id"] = id
		body["table"] = "c"
		_, m, _ := dbCall(t, s, "POST", "/api/db/apply", body)
		return m
	}

	// apaga 2, muda nome e cidade de 1, insere dois (um só com o padrão da cidade)
	m := apply(map[string]any{
		"deletes": []any{map[string]any{"where": map[string]any{"id": 2}}},
		"updates": []any{map[string]any{"where": map[string]any{"id": 1}, "set": map[string]any{"nome": "Ana Maria", "cidade": nil}}},
		"inserts": []any{
			map[string]any{"values": map[string]any{"id": "10", "nome": "Davi", "cidade": "Natal"}},
			map[string]any{"values": map[string]any{"id": 11, "nome": "Eva"}},
		},
	})
	if m["ok"] != true || m["deleted"] != float64(1) || m["updated"] != float64(1) || m["inserted"] != float64(2) {
		t.Fatalf("aplicar: %v", m)
	}
	if got := names(); got != "1:Ana Maria:- 3:Caio:Recife 10:Davi:Natal 11:Eva:Recife" {
		t.Fatalf("depois: %s", got)
	}

	// uma linha que não existe mais desfaz tudo
	m = apply(map[string]any{
		"updates": []any{map[string]any{"where": map[string]any{"id": 3}, "set": map[string]any{"nome": "Caio X"}}},
		"deletes": []any{map[string]any{"where": map[string]any{"id": 99}}},
	})
	if m["change"] != "delete" || m["index"] != float64(0) || !strings.Contains(m["error"].(string), "não existe mais") {
		t.Fatalf("linha sumida: %v", m)
	}
	if got := names(); !strings.Contains(got, "3:Caio:") {
		t.Fatalf("devia desfazer tudo: %s", got)
	}

	// NULL em coluna obrigatória: recusado antes de gravar
	m = apply(map[string]any{"inserts": []any{map[string]any{"values": map[string]any{"nome": nil}}}})
	if m["change"] != "insert" || !strings.Contains(m["error"].(string), "não aceita NULL") {
		t.Fatalf("NULL: %v", m)
	}
	// coluna que não existe
	m = apply(map[string]any{"updates": []any{map[string]any{"where": map[string]any{"id": 1}, "set": map[string]any{"x; drop": "1"}}}})
	if !strings.Contains(m["error"].(string), "coluna desconhecida") {
		t.Fatalf("coluna: %v", m)
	}
	// mesmo valor de antes conta como 1 linha (não "a linha não existe")
	m = apply(map[string]any{"updates": []any{map[string]any{"where": map[string]any{"id": 3}, "set": map[string]any{"nome": "Caio"}}}})
	if m["ok"] != true {
		t.Fatalf("mesmo valor: %v", m)
	}
}

func TestDBApplyDefaultValues(t *testing.T) {
	s, dir, _ := dbTestEnv(t, false)
	file := filepath.Join(dir, "def.db")
	id := saveConn(t, s, map[string]any{"name": "def", "driver": "sqlite", "file": file, "create_file": true}, nil)
	dbRunConfirmed(t, s, id, `CREATE TABLE d (id INTEGER PRIMARY KEY, n TEXT DEFAULT 'x')`)
	_, m, raw := dbCall(t, s, "POST", "/api/db/apply", map[string]any{"id": id, "table": "d", "inserts": []any{map[string]any{"values": map[string]any{}}}})
	if m["ok"] != true || m["inserted"] != float64(1) {
		t.Fatalf("só padrões: %s", raw)
	}
}
