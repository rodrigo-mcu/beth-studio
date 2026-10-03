package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLifeLineFormat(t *testing.T) {
	tm := time.Date(2026, 10, 3, 1, 2, 49, 503*int(time.Millisecond), time.Local)
	got := lifeLine(tm, 4321, "host iniciado")
	if want := "2026-10-03 01:02:49.503 pid=4321 studio host iniciado"; got != want {
		t.Fatalf("lifeLine = %q, quero %q", got, want)
	}
}

func TestLifeLogAppendsToDataDir(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("BETHTERM_DATA_DIR", dir)
	lifeLog("primeira")
	lifeLog("segunda")
	b, err := os.ReadFile(filepath.Join(dir, "host-life.log"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) != 2 || !strings.HasSuffix(lines[0], "studio primeira") || !strings.HasSuffix(lines[1], "studio segunda") {
		t.Fatalf("log = %q", lines)
	}
}

func TestHostExeIn(t *testing.T) {
	dir := t.TempDir()
	if _, err := hostExeIn(dir); err == nil {
		t.Fatal("sem o exe na pasta deveria falhar")
	}
	exe := filepath.Join(dir, "bethterm-host.exe")
	if err := os.WriteFile(exe, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := hostExeIn(dir)
	if err != nil || got != exe {
		t.Fatalf("hostExeIn = %q, %v", got, err)
	}
}

func TestQuitRequestTextNamesTheRequester(t *testing.T) {
	tm := time.Date(2026, 10, 3, 12, 0, 0, 0, time.Local)
	got := quitRequestText(tm, 99, `C:\x\bethterm-web.exe`, "Studio Encerrar tudo (confirmado)")
	for _, part := range []string{"pid=99", `exe=C:\x\bethterm-web.exe`, "reason=Studio Encerrar tudo (confirmado)"} {
		if !strings.Contains(got, part) {
			t.Fatalf("falta %q em %q", part, got)
		}
	}
}

func TestHostIDSanitizedLikeTheHost(t *testing.T) {
	t.Setenv("BETHTERM_HOST_ID", "../a b!c-1_x")
	if got := hostID(); got != "abc-1_x" {
		t.Fatalf("hostID = %q, quero abc-1_x", got)
	}
	t.Setenv("BETHTERM_HOST_ID", strings.Repeat("a", 60))
	if got := hostID(); len(got) != 48 {
		t.Fatalf("hostID com %d caracteres, quero 48", len(got))
	}
}

func TestHostNamesAndFilesWithAndWithoutID(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("BETHTERM_DATA_DIR", dir)
	t.Setenv("BETHTERM_HOST_ID", "")
	if hostMutex() != `Local\BethTermHost` || hostQuitEvent() != `Local\BethTermHostQuit` {
		t.Fatalf("host único: %q %q", hostMutex(), hostQuitEvent())
	}
	if hostSockPath() != filepath.Join(dir, "host.sock") || quitRequestPath() != filepath.Join(dir, "host.quit-request") || hostPidPath() != filepath.Join(dir, "host.pid") {
		t.Fatalf("arquivos do host único: %q %q %q", hostSockPath(), quitRequestPath(), hostPidPath())
	}
	t.Setenv("BETHTERM_HOST_ID", "teste1")
	if hostMutex() != `Local\BethTermHost-teste1` || hostQuitEvent() != `Local\BethTermHostQuit-teste1` {
		t.Fatalf("host com id: %q %q", hostMutex(), hostQuitEvent())
	}
	if hostSockPath() != filepath.Join(dir, "hosts", "teste1.sock") || quitRequestPath() != filepath.Join(dir, "hosts", "teste1.quit-request") {
		t.Fatalf("arquivos do host com id: %q %q", hostSockPath(), quitRequestPath())
	}
}
