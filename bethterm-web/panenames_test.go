package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func listJSON(panes ...map[string]any) []byte {
	b, _ := json.Marshal(map[string]any{"ev": "list", "panes": panes})
	return b
}

func pane(id int, title, cwd string) map[string]any {
	return map[string]any{"pane_id": id, "title": title, "cwd": cwd}
}

func TestPaneNamesPersistAndAdopt(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "host.pid"), []byte("100"), 0o600)
	st := &settingsStore{}
	st.load(dir)
	st.reconcile(listJSON(pane(3, "claude", "file:///c/repo"), pane(4, "pwsh", "file:///c/x")))

	// renomear a aba com os panes 3 e 4 guarda o nome nos dois
	snap, err := st.setPaneNames([]int{3, 4, 99}, "  Projeto X  ")
	if err != nil {
		t.Fatal(err)
	}
	if snap.PaneNames["3"] != "Projeto X" || snap.PaneNames["4"] != "Projeto X" || snap.PaneNames["99"] != "" {
		t.Fatalf("nomes = %v", snap.PaneNames)
	}

	// grava no disco e volta ao recarregar
	st2 := &settingsStore{}
	st2.load(dir)
	st2.reconcile(listJSON(pane(3, "claude", "file:///c/repo"), pane(4, "pwsh", "file:///c/x")))
	if n := st2.snapshot().PaneNames; n["3"] != "Projeto X" || n["4"] != "Projeto X" {
		t.Fatalf("recarregado = %v", n)
	}

	// host reiniciado: o pane 3 (mesma pasta) e' adotado; o 4 mudou de dono
	time.Sleep(1100 * time.Millisecond) // host.pid novo => outro host id
	os.WriteFile(filepath.Join(dir, "host.pid"), []byte("200"), 0o600)
	st2.reconcile(listJSON(pane(3, "outro titulo", "file:///c/repo"), pane(4, "cmd", "file:///c/y")))
	n := st2.snapshot().PaneNames
	if n["3"] != "Projeto X" || n["4"] != "" {
		t.Fatalf("adoção = %v", n)
	}

	// "Usar o nome do terminal" (nome vazio) apaga
	snap, _ = st2.setPaneNames([]int{3}, "")
	if _, ok := snap.PaneNames["3"]; ok {
		t.Fatalf("apagar = %v", snap.PaneNames)
	}

	// nome muito longo e' cortado; lista vazia e' erro
	snap, _ = st2.setPaneNames([]int{3}, "123456789012345678901234567890123456789012345678901234567890XYZ")
	if len([]rune(snap.PaneNames["3"])) != paneNameMaxLen {
		t.Fatalf("corte = %q", snap.PaneNames["3"])
	}
	if _, err := st2.setPaneNames(nil, "x"); err == nil {
		t.Fatal("lista vazia aceita")
	}
}

func TestPaneNamesPruneAfter14DaysGone(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "host.pid"), []byte("100"), 0o600)
	st := &settingsStore{}
	st.load(dir)
	st.reconcile(listJSON(pane(5, "a", "file:///c/a")))
	st.setPaneNames([]int{5}, "Nome")
	host := st.hostID()

	st.mu.Lock()
	st.live = map[int]paneMeta{} // o pane 5 foi encerrado
	now := time.Now()
	st.reconcilePaneNamesLocked(host, now)
	if st.s.PaneNames["5"] == nil || st.s.PaneNames["5"].GoneSince == "" {
		st.mu.Unlock()
		t.Fatal("encerrado deve marcar GoneSince e manter o nome")
	}
	st.reconcilePaneNamesLocked(host, now.Add(13*24*time.Hour))
	if st.s.PaneNames["5"] == nil {
		st.mu.Unlock()
		t.Fatal("apagado antes de 14 dias")
	}
	// voltou antes de 14 dias: limpa a marca
	st.live = map[int]paneMeta{5: {"a", "file:///c/a"}}
	st.reconcilePaneNamesLocked(host, now.Add(13*24*time.Hour))
	if st.s.PaneNames["5"].GoneSince != "" {
		st.mu.Unlock()
		t.Fatal("pane vivo de novo deve limpar GoneSince")
	}
	st.live = map[int]paneMeta{}
	st.reconcilePaneNamesLocked(host, now)
	st.reconcilePaneNamesLocked(host, now.Add(15*24*time.Hour))
	_, still := st.s.PaneNames["5"]
	st.mu.Unlock()
	if still {
		t.Fatal("nome de pane encerrado há mais de 14 dias deve sumir")
	}
}

func TestPaneNamesWithoutHostPid(t *testing.T) {
	st := &settingsStore{}
	st.load(t.TempDir()) // sem host.pid
	st.reconcile(listJSON(pane(1, "pwsh", "file:///c/x")))
	st.setPaneNames([]int{1}, "Nome")
	st.reconcile(listJSON(pane(1, "pwsh", "file:///c/x")))
	st.mu.Lock()
	gone := st.s.PaneNames["1"].GoneSince
	st.mu.Unlock()
	if gone != "" || st.snapshot().PaneNames["1"] != "Nome" {
		t.Fatalf("sem host.pid: gone=%q view=%v", gone, st.snapshot().PaneNames)
	}
}
