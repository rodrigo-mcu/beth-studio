package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStudioTermTheme(t *testing.T) {
	cases := []struct {
		ui   *UITheme
		want string
	}{
		{nil, ""},
		{&UITheme{Mode: "dark"}, ""},
		{&UITheme{Mode: "navy"}, ""},
		{&UITheme{Mode: "follow"}, ""},
		{&UITheme{Mode: "light"}, studioLightTermTheme},
		{&UITheme{Mode: "x-light"}, studioLightTermTheme}, // modo antigo
		{&UITheme{Mode: "theme", ThemeID: "apple-system-colors-light"}, "apple-system-colors-light"},
	}
	for _, c := range cases {
		if got := studioTermTheme(c.ui); got != c.want {
			t.Errorf("%+v: %q, quero %q", c.ui, got, c.want)
		}
	}
}

// Terminal sem tema proprio segue a interface; o que o usuario escolheu no
// terminal vale; "Tema padrao dos terminais" explicito ganha da interface.
func TestEffectiveThemeFollowsStudio(t *testing.T) {
	st := &settingsStore{}
	st.load(t.TempDir())
	st.reconcile(listJSON(pane(1, "pwsh", "file:///c/a"), pane(2, "ssh", "file:///c/b")))
	if _, err := st.setPane(2, Appearance{Theme: "vscode_dark"}); err != nil {
		t.Fatal(err)
	}
	st.mu.Lock()
	st.s.UITheme = &UITheme{Mode: "theme", ThemeID: "apple-system-colors-light"}
	st.mu.Unlock()

	got := st.effectiveThemeIDs()
	if got[1] != "apple-system-colors-light" || got[2] != "vscode_dark" {
		t.Fatalf("segue o Studio / mantem o do usuario: %v", got)
	}

	st.mu.Lock()
	st.s.Default.Theme = "homebrew-light"
	st.mu.Unlock()
	if got := st.effectiveThemeIDs(); got[1] != "homebrew-light" || got[2] != "vscode_dark" {
		t.Fatalf("padrao explicito: %v", got)
	}
}

// Depois de reiniciar o host, um pane criado pelo web nao herda o tema de
// um terminal antigo com o mesmo numero e a mesma pasta. Um pane restaurado
// (nao criado pelo web) continua recuperando o seu.
func TestFreshSpawnDoesNotAdoptOldTheme(t *testing.T) {
	dir := t.TempDir()
	pid := filepath.Join(dir, "host.pid")
	os.WriteFile(pid, []byte("100"), 0o600)
	st := &settingsStore{}
	st.load(dir)
	st.reconcile(listJSON(pane(7, "pwsh", "file:///C:/Users/x/"), pane(8, "pwsh", "file:///C:/Users/x/")))
	for _, id := range []int{7, 8} {
		if _, err := st.setPane(id, Appearance{Theme: "vscode_light"}); err != nil {
			t.Fatal(err)
		}
	}

	// host novo
	os.WriteFile(pid, []byte("200"), 0o600)
	later := time.Now().Add(time.Hour)
	os.Chtimes(pid, later, later)

	st.recordSpawn(7, "pwsh") // o web abriu um terminal novo que ganhou o numero 7
	st.reconcile(listJSON(pane(7, "pwsh", "file:///C:/Users/x/"), pane(8, "pwsh", "file:///C:/Users/x/")))

	st.mu.Lock()
	_, kept7 := st.s.Panes["7"]
	p8 := st.s.Panes["8"]
	st.mu.Unlock()
	if kept7 {
		t.Fatal("terminal novo herdou o tema de um terminal antigo")
	}
	if p8 == nil || p8.Theme != "vscode_light" {
		t.Fatalf("terminal restaurado perdeu o tema: %+v", p8)
	}
}

// Dois processos no mesmo web-settings.json (dois Studios, ou Studio + janela
// do banco/SFTP): a reconciliacao de um nao pode apagar o tema que o outro
// acabou de gravar. Antes, o tema voltava ao escuro ao trocar de aba.
func TestReconcileKeepsThemeSavedByOtherProcess(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "host.pid"), []byte("100"), 0o600)
	list := listJSON(pane(59, "Lista", "file:///m/"), pane(60, "pwsh", "file:///c/"))

	a, b := &settingsStore{}, &settingsStore{}
	a.load(dir)
	b.load(dir)
	a.reconcile(list)
	b.reconcile(list)

	time.Sleep(20 * time.Millisecond) // mtime diferente no NTFS/ext4
	if _, err := a.setPane(59, Appearance{Theme: "vscode_light"}); err != nil {
		t.Fatal(err)
	}
	// b tem titulos pendentes e grava na reconciliacao
	b.mu.Lock()
	b.dirty = true
	b.savedAt = time.Time{}
	b.mu.Unlock()
	b.reconcile(listJSON(pane(59, "Lista 2", "file:///m/"), pane(60, "pwsh", "file:///c/")))
	b.flush()

	c := &settingsStore{}
	c.load(dir)
	if p := c.s.Panes["59"]; p == nil || p.Theme != "vscode_light" {
		t.Fatalf("tema do pane 59 perdido: %+v", p)
	}
	if got := b.effectiveThemeIDs()[59]; got != "vscode_light" {
		t.Fatalf("o outro processo nao ve o tema: %q", got)
	}
}
