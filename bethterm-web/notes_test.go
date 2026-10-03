package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestNotesSaveListReadDelete(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "notes")
	t0 := time.Date(2026, 10, 2, 15, 4, 5, 0, time.Local)

	id, err := notesSave(dir, "", "# Reunião\ncorpo", t0)
	if err != nil || id != "2026-10-02_15-04-05" {
		t.Fatalf("id=%q err=%v", id, err)
	}
	// mesmo segundo: não sobrescreve a outra nota
	id2, err := notesSave(dir, "", "outra", t0)
	if err != nil || id2 != "2026-10-02_15-04-05-1" {
		t.Fatalf("id2=%q err=%v", id2, err)
	}
	// com id, atualiza a mesma nota
	if _, err := notesSave(dir, id, "# Reunião\ncorpo novo", t0); err != nil {
		t.Fatal(err)
	}
	text, err := notesRead(dir, id)
	if err != nil || text != "# Reunião\ncorpo novo" {
		t.Fatalf("text=%q err=%v", text, err)
	}
	l, err := notesList(dir)
	if err != nil || len(l) != 2 {
		t.Fatalf("list=%v err=%v", l, err)
	}
	for _, n := range l {
		if n.ID == id && n.Title != "Reunião" {
			t.Fatalf("título = %q", n.Title)
		}
	}
	if err := notesDelete(dir, id); err != nil {
		t.Fatal(err)
	}
	if _, err := notesRead(dir, id); err == nil {
		t.Fatal("a nota apagada ainda existe")
	}
	if l, _ := notesList(dir); len(l) != 1 {
		t.Fatalf("depois de apagar: %v", l)
	}
}

func TestNotesRejectsBadInput(t *testing.T) {
	dir := t.TempDir()
	if _, err := notesSave(dir, "", "   \n ", time.Now()); err == nil {
		t.Fatal("nota vazia foi aceita")
	}
	for _, id := range []string{"../x", "..\\x", "abc", "2026-10-02_15-04-05/../../x", ""} {
		if _, err := notesRead(dir, id); err == nil {
			t.Fatalf("id %q aceito", id)
		}
		if err := notesDelete(dir, id); err == nil {
			t.Fatalf("delete de %q aceito", id)
		}
	}
	// arquivos que não são notas ficam fora da lista
	_ = os.WriteFile(filepath.Join(dir, "lixo.md"), []byte("x"), 0o644)
	if l, _ := notesList(dir); len(l) != 0 {
		t.Fatalf("lista = %v", l)
	}
}

func TestNoteTitle(t *testing.T) {
	cases := map[string]string{
		"":                 "(vazia)",
		"\n\n  ## Oi  \nx": "Oi",
		"linha simples":    "linha simples",
	}
	for in, want := range cases {
		if got := noteTitle(in); got != want {
			t.Errorf("noteTitle(%q) = %q, quer %q", in, got, want)
		}
	}
}
