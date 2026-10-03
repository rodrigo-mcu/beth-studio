package main

import "testing"

func TestDbAssistParse(t *testing.T) {
	sql, answer := dbAssistParse("fix", "```sql\nSELECT 1\n```")
	if sql != "SELECT 1" || answer != "" {
		t.Fatalf("fix: %q %q", sql, answer)
	}
	sql, answer = dbAssistParse("fix", "SELECT id FROM clientes")
	if sql != "SELECT id FROM clientes" || answer != "" {
		t.Fatalf("plain: %q %q", sql, answer)
	}
	sql, answer = dbAssistParse("ask", "A tabela clientes guarda pessoas.\n```sql\nSELECT nome FROM clientes\n```")
	if sql != "SELECT nome FROM clientes" || answer == "" {
		t.Fatalf("ask: %q %q", sql, answer)
	}
	if _, ok := dbAssistNames("SELECT Nome FROM Clientes")["clientes"]; !ok {
		t.Fatal("nome da tabela não entrou")
	}
}
