package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
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

func newTestGate(f *fakeWSL, cfg map[string]wslDistroCfg) *wslGate {
	f.clk = time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	g := newWSLGate(f.run, cfg)
	g.now = func() time.Time { return f.clk }
	g.sleep = func(d time.Duration) { f.clk = f.clk.Add(d) }
	return g
}

func TestEnsureAlreadyRunningDoesNotStartIt(t *testing.T) {
	f := &fakeWSL{running: map[string]bool{"Debian": true}, bootID: "b1"}
	g := newTestGate(f, nil)
	if _, err := g.Ensure(context.Background(), "Debian"); err != nil {
		t.Fatal(err)
	}
	if f.count("--exec true") != 0 {
		t.Fatal("a distro já roda: não deveria iniciá-la")
	}
}

func TestEnsureStartsAStoppedDistro(t *testing.T) {
	f := &fakeWSL{running: map[string]bool{}, bootID: "b1"}
	g := newTestGate(f, nil)
	if _, err := g.Ensure(context.Background(), "Debian"); err != nil {
		t.Fatal(err)
	}
	if f.count("wsl.exe -d Debian --exec true") != 1 {
		t.Fatalf("deveria iniciar a distro uma vez: %v", f.calls)
	}
}

func TestEnsureRetriesUntilTheDistroStarts(t *testing.T) {
	f := &fakeWSL{running: map[string]bool{}, startOK: 2, bootID: "b1"}
	g := newTestGate(f, nil)
	if _, err := g.Ensure(context.Background(), "Debian"); err != nil {
		t.Fatalf("a 3ª tentativa deveria dar certo: %v", err)
	}
	if f.started != 3 {
		t.Fatalf("tentativas = %d, quero 3", f.started)
	}
}

func TestEnsureGivesUpAfterTheDeadline(t *testing.T) {
	f := &fakeWSL{running: map[string]bool{}, startOK: 1 << 30, bootID: "b1"}
	g := newTestGate(f, nil)
	start := f.clk
	_, err := g.Ensure(context.Background(), "Debian")
	if err == nil {
		t.Fatal("distro que nunca sobe deveria dar erro")
	}
	if waited := f.clk.Sub(start); waited < 60*time.Second || waited > 90*time.Second {
		t.Fatalf("esperou %v, quero cerca de 60 s", waited)
	}
}

func TestEnsureRunsInitOncePerBoot(t *testing.T) {
	f := &fakeWSL{running: map[string]bool{"Debian": true}, bootID: "boot-A"}
	g := newTestGate(f, map[string]wslDistroCfg{"debian": {Init: "service foo start", User: "root"}})
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if _, err := g.Ensure(ctx, "Debian"); err != nil {
			t.Fatal(err)
		}
	}
	if n := f.count("--exec sh -c"); n != 1 {
		t.Fatalf("init rodou %d vezes no mesmo boot, quero 1", n)
	}
	f.bootID = "boot-B" // a VM reiniciou
	if _, err := g.Ensure(ctx, "Debian"); err != nil {
		t.Fatal(err)
	}
	if n := f.count("--exec sh -c"); n != 2 {
		t.Fatalf("init rodou %d vezes, quero 2 (um por boot)", n)
	}
}

func TestEnsureInitArguments(t *testing.T) {
	f := &fakeWSL{running: map[string]bool{"Debian": true}, bootID: "b1"}
	g := newTestGate(f, map[string]wslDistroCfg{"debian": {Init: "echo oi && true", User: "alice"}})
	if _, err := g.Ensure(context.Background(), "Debian"); err != nil {
		t.Fatal(err)
	}
	want := "wsl.exe -d Debian -u alice --exec sh -c echo oi && true"
	found := false
	for _, c := range f.calls {
		if c == want {
			found = true
		}
	}
	if !found {
		t.Fatalf("falta a chamada %q em %v", want, f.calls)
	}
}

func TestEnsureDefaultInitUserIsRoot(t *testing.T) {
	f := &fakeWSL{running: map[string]bool{"Debian": true}, bootID: "b1"}
	g := newTestGate(f, map[string]wslDistroCfg{"debian": {Init: "true"}})
	_, _ = g.Ensure(context.Background(), "Debian")
	if f.count("-u root --exec sh -c true") != 1 {
		t.Fatalf("usuário padrão deveria ser root: %v", f.calls)
	}
}

func TestEnsureInitFailureIsReportedButNotFatal(t *testing.T) {
	f := &fakeWSL{running: map[string]bool{"Debian": true}, bootID: "b1", initErr: errors.New("exit status 3")}
	g := newTestGate(f, map[string]wslDistroCfg{"debian": {Init: "false"}})
	initErr, err := g.Ensure(context.Background(), "Debian")
	if err != nil {
		t.Fatalf("falha no init não pode impedir a distro de servir: %v", err)
	}
	if initErr == nil {
		t.Fatal("a falha do init deveria ser devolvida como aviso")
	}
}

func TestWaitDirAppearsLater(t *testing.T) {
	f := &fakeWSL{dirAfter: 3}
	g := newTestGate(f, nil)
	if !g.WaitDir(context.Background(), "Debian", "/mnt/data/projetos") {
		t.Fatal("a pasta aparece na 4ª tentativa: deveria devolver true")
	}
	if f.dirTries != 4 {
		t.Fatalf("tentativas = %d, quero 4", f.dirTries)
	}
}

func TestWaitDirNeverAppears(t *testing.T) {
	f := &fakeWSL{dirAfter: -1}
	g := newTestGate(f, nil)
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
	g := newTestGate(f, nil)
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
	g := newTestGate(f, nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if g.WaitDir(ctx, "Debian", "/mnt/x") {
		t.Fatal("contexto cancelado deveria devolver false")
	}
}

func TestLoadWSLDistroCfgIsCaseInsensitive(t *testing.T) {
	dir := t.TempDir()
	body := `{"Debian":{"init":"service x start","user":"root","timeout_sec":90},"Ubuntu-22.04":{"init":"true"}}`
	if err := os.WriteFile(filepath.Join(dir, "wsl-distros.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := loadWSLDistroCfg(dir)
	if c := cfg["debian"]; c.Init != "service x start" || c.TimeoutSec != 90 {
		t.Fatalf("debian = %+v", c)
	}
	if c := cfg["ubuntu-22.04"]; c.Init != "true" {
		t.Fatalf("ubuntu = %+v", c)
	}
	if got := loadWSLDistroCfg(t.TempDir()); len(got) != 0 {
		t.Fatalf("sem arquivo deveria vir vazio: %+v", got)
	}
	_ = os.WriteFile(filepath.Join(dir, "wsl-distros.json"), []byte("não é json"), 0o644)
	if got := loadWSLDistroCfg(dir); len(got) != 0 {
		t.Fatalf("arquivo inválido deveria vir vazio: %+v", got)
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

func TestLoadWSLDistroCfgToleratesUTF8BOM(t *testing.T) {
	dir := t.TempDir()
	body := append([]byte{0xEF, 0xBB, 0xBF}, []byte(`{"Debian":{"init":"true","user":"root"}}`)...)
	if err := os.WriteFile(filepath.Join(dir, "wsl-distros.json"), body, 0o644); err != nil {
		t.Fatal(err)
	}
	if c := loadWSLDistroCfg(dir)["debian"]; c.Init != "true" {
		t.Fatalf("wsl-distros.json com BOM deveria ser lido: %+v", c)
	}
}
