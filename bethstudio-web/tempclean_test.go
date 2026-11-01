package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestTempCleanRemovesOnlyOldOwnedFiles(t *testing.T) {
	img, txt := t.TempDir(), t.TempDir()
	oi, ot := imageDir, textDir
	imageDir = func() string { return img }
	textDir = func() string { return txt }
	t.Cleanup(func() { imageDir, textDir = oi, ot })

	now := time.Now()
	mk := func(dir, name string, age time.Duration) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("xxxx"), 0o644); err != nil {
			t.Fatal(err)
		}
		at := now.Add(-age)
		_ = os.Chtimes(p, at, at)
		return p
	}
	day := 24 * time.Hour
	oldImg := mk(img, "clipboard-1x1-1.png", 11*day)
	oldFile := mk(img, "file-1-a.pdf", 12*day)
	newImg := mk(img, "clipboard-1x1-2.png", 2*day)
	other := mk(img, "meu-arquivo.txt", 30*day) // não é nosso: nunca apaga
	oldTxt := mk(txt, "fala-1.txt", 20*day)
	if err := os.Mkdir(filepath.Join(img, "file-dir"), 0o755); err != nil {
		t.Fatal(err)
	}

	st := tempCleanScan(10, false, now)
	if st.Files != 4 || st.OldFiles != 3 || st.RemovedFiles != 0 {
		t.Fatalf("contagem: %+v", st)
	}
	st = tempCleanScan(10, true, now)
	if st.RemovedFiles != 3 || st.RemovedBytes != 12 {
		t.Fatalf("remoção: %+v", st)
	}
	for _, p := range []string{oldImg, oldFile, oldTxt} {
		if _, err := os.Stat(p); err == nil {
			t.Fatalf("devia ter apagado %s", p)
		}
	}
	for _, p := range []string{newImg, other, filepath.Join(img, "file-dir")} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("não devia apagar %s", p)
		}
	}
	// 15 dias: o de 11 e 12 dias ficaria; aqui só confirma o ajuste de dias
	if (TempCleanSettings{}).days() != 10 || (TempCleanSettings{Days: 15}).days() != 15 || (TempCleanSettings{Days: 9999}).days() != 365 {
		t.Fatal("dias padrão/limites")
	}
}
