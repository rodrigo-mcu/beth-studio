package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// fakeWSL simula o wsl.exe. Cada chave é os argumentos juntados por espaço.
type fakeWSL struct {
	clk      time.Time
	calls    []string
	running  map[string]bool
	startOK  int // quantas tentativas de `--exec true` falham antes de dar certo
	started  int
	bootID   string
	dirAfter int // `test -d` passa a dar certo depois de N tentativas (-1 = nunca)
	dirTries int
	initErr  error
}

func (f *fakeWSL) run(_ context.Context, _ time.Duration, name string, args ...string) ([]byte, error) {
	key := name + " " + strings.Join(args, " ")
	f.calls = append(f.calls, key)
	switch {
	case strings.HasPrefix(key, "wsl.exe -l --running -q"):
		var names []string
		for d, ok := range f.running {
			if ok {
				names = append(names, d)
			}
		}
		return []byte(strings.Join(names, "\r\n")), nil
	case strings.Contains(key, "--exec true"):
		f.started++
		if f.started <= f.startOK {
			return nil, errors.New("Wsl/Service/CreateInstance/E_FAIL")
		}
		d := args[1]
		f.running[d] = true
		return nil, nil
	case strings.Contains(key, "cat /proc/sys/kernel/random/boot_id"):
		return []byte(f.bootID + "\n"), nil
	case strings.Contains(key, "--exec sh -c"):
		return nil, f.initErr
	case strings.Contains(key, "--exec test -d"):
		f.dirTries++
		if f.dirAfter >= 0 && f.dirTries > f.dirAfter {
			return nil, nil
		}
		return nil, errors.New("exit status 1")
	}
	return nil, errors.New("comando inesperado: " + key)
}

func (f *fakeWSL) count(sub string) int {
	n := 0
	for _, c := range f.calls {
		if strings.Contains(c, sub) {
			n++
		}
	}
	return n
}

func newTestGate(f *fakeWSL) *wslGate {
	f.clk = time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	g := newWSLGate(f.run)
	g.now = func() time.Time { return f.clk }
	g.sleep = func(d time.Duration) { f.clk = f.clk.Add(d) }
	return g
}

func TestEnsureAlreadyRunningDoesNotStartIt(t *testing.T) {
	f := &fakeWSL{running: map[string]bool{"Debian": true}, bootID: "b1"}
	g := newTestGate(f)
	if err := g.Ensure(context.Background(), "Debian"); err != nil {
		t.Fatal(err)
	}
	if f.count("--exec true") != 0 {
		t.Fatal("a distro já roda: não deveria iniciá-la")
	}
}

func TestEnsureStartsAStoppedDistro(t *testing.T) {
	f := &fakeWSL{running: map[string]bool{}, bootID: "b1"}
	g := newTestGate(f)
	if err := g.Ensure(context.Background(), "Debian"); err != nil {
		t.Fatal(err)
	}
	if f.count("wsl.exe -d Debian --exec true") != 1 {
		t.Fatalf("deveria iniciar a distro uma vez: %v", f.calls)
	}
}

func TestEnsureRetriesUntilTheDistroStarts(t *testing.T) {
	f := &fakeWSL{running: map[string]bool{}, startOK: 2, bootID: "b1"}
	g := newTestGate(f)
	if err := g.Ensure(context.Background(), "Debian"); err != nil {
		t.Fatalf("a 3ª tentativa deveria dar certo: %v", err)
	}
	if f.started != 3 {
		t.Fatalf("tentativas = %d, quero 3", f.started)
	}
}

func TestEnsureGivesUpAfterTheDeadline(t *testing.T) {
	f := &fakeWSL{running: map[string]bool{}, startOK: 1 << 30, bootID: "b1"}
	g := newTestGate(f)
	start := f.clk
	err := g.Ensure(context.Background(), "Debian")
	if err == nil {
		t.Fatal("distro que nunca sobe deveria dar erro")
	}
	if waited := f.clk.Sub(start); waited < 60*time.Second || waited > 90*time.Second {
		t.Fatalf("esperou %v, quero cerca de 60 s", waited)
	}
}

func TestWaitDirAppearsLater(t *testing.T) {
	f := &fakeWSL{dirAfter: 3}
	g := newTestGate(f)
	if !g.WaitDir(context.Background(), "Debian", "/mnt/data/projetos") {
		t.Fatal("a pasta aparece na 4ª tentativa: deveria devolver true")
	}
	if f.dirTries != 4 {
		t.Fatalf("tentativas = %d, quero 4", f.dirTries)
	}
}

func TestWaitDirNeverAppears(t *testing.T) {
	f := &fakeWSL{dirAfter: -1}
	g := newTestGate(f)
	start := f.clk
	if g.WaitDir(context.Background(), "Debian", "/mnt/nao/existe") {
		t.Fatal("pasta que não existe deveria devolver false")
	}
	if waited := f.clk.Sub(start); waited < 30*time.Second || waited > 40*time.Second {
		t.Fatalf("esperou %v, quero cerca de 30 s", waited)
	}
}

func TestWaitDirEmptyOrHomeNeedsNoWait(t *testing.T) {
	f := &fakeWSL{dirAfter: -1}
	g := newTestGate(f)
	for _, p := range []string{"", "~"} {
		if !g.WaitDir(context.Background(), "Debian", p) {
			t.Fatalf("%q não precisa esperar", p)
		}
	}
	if len(f.calls) != 0 {
		t.Fatalf("não deveria chamar o wsl.exe: %v", f.calls)
	}
}

func TestWaitDirHonorsCancellation(t *testing.T) {
	f := &fakeWSL{dirAfter: -1}
	g := newTestGate(f)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if g.WaitDir(ctx, "Debian", "/mnt/x") {
		t.Fatal("contexto cancelado deveria devolver false")
	}
}

func TestWSLDistroForShell(t *testing.T) {
	installed := []string{"Debian", "Ubuntu-22.04"}
	cases := []struct{ shell, distro, want string }{
		{"wsl.default", "", "Debian"},
		{"wsl.default", "Ubuntu-22.04", "Ubuntu-22.04"},
		{"wsl.ubuntu-22.04", "", "Ubuntu-22.04"},
		{"wsl.debian", "", "Debian"},
		{"wsl.naoexiste", "", ""},
	}
	for _, c := range cases {
		if got := wslDistroForShell(c.shell, c.distro, installed, "Debian"); got != c.want {
			t.Errorf("wslDistroForShell(%q, %q) = %q, quero %q", c.shell, c.distro, got, c.want)
		}
	}
}

func TestSpawnErrorWithRequestIsRecognizedByTheHub(t *testing.T) {
	msg := spawnErrorWithRequest("r42", errors.New("a distro Debian não respondeu"))
	if got := spawnErrRequestID(msg); got != "r42" {
		t.Fatalf("request id lido = %q em %q", got, msg)
	}
}

func TestDirExistsChecksOnce(t *testing.T) {
	f := &fakeWSL{dirAfter: 1} // 1ª chamada falha, a seguinte passa
	g := newTestGate(f)
	if g.DirExists(context.Background(), "Debian", "/mnt/data/a") {
		t.Fatal("1ª checagem deveria dar false")
	}
	if !g.DirExists(context.Background(), "Debian", "/mnt/data/a") {
		t.Fatal("2ª checagem deveria dar true")
	}
	if n := f.count("wsl.exe -d Debian --exec test -d /mnt/data/a"); n != 2 {
		t.Fatalf("cada DirExists é uma chamada só, sem esperar: %d chamadas em %v", n, f.calls)
	}
}

func TestDirExistsHomeAndEmpty(t *testing.T) {
	f := &fakeWSL{dirAfter: -1}
	g := newTestGate(f)
	if !g.DirExists(context.Background(), "Debian", "~") || !g.DirExists(context.Background(), "Debian", "") {
		t.Fatal("pasta vazia ou ~ não depende de checagem: conta como existente")
	}
	if len(f.calls) != 0 {
		t.Fatalf("não deveria chamar o wsl.exe: %v", f.calls)
	}
}

func TestEnsureNeverRunsInit(t *testing.T) {
	f := &fakeWSL{running: map[string]bool{"Debian": true}, bootID: "b1"}
	g := newTestGate(f)
	if err := g.Ensure(context.Background(), "Debian"); err != nil {
		t.Fatal(err)
	}
	if n := f.count("--exec sh -c"); n != 0 {
		t.Fatalf("o init só roda pelo fluxo guiado, não no Ensure: %v", f.calls)
	}
}

func TestBootIDTrimsOutput(t *testing.T) {
	f := &fakeWSL{running: map[string]bool{"Debian": true}, bootID: "abc-123"}
	g := newTestGate(f)
	if got := g.BootID(context.Background(), "Debian"); got != "abc-123" {
		t.Fatalf("BootID = %q", got)
	}
}
