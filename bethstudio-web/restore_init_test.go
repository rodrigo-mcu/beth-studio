package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestInitTypedLine(t *testing.T) {
	got := initTypedLine("init-wsl2", "/tmp/.bethstudio-init-abc")
	want := "init-wsl2; echo $? > /tmp/.bethstudio-init-abc\r"
	if got != want {
		t.Fatalf("initTypedLine = %q, quero %q", got, want)
	}
}

func TestInitMarkerPath(t *testing.T) {
	if got := initMarkerPath("abc-123"); got != "/tmp/.bethstudio-init-abc-123" {
		t.Fatalf("marcador = %q", got)
	}
	if got := initMarkerPath(""); got != "/tmp/.bethstudio-init-nb" {
		t.Fatalf("sem boot id = %q", got)
	}
	// o boot id vem de fora da distro: nada além de letras, números, ponto, hífen e sublinhado entra no caminho
	if got := initMarkerPath("a b;rm -rf /"); strings.ContainsAny(got, " ;") {
		t.Fatalf("boot id hostil escapou para o caminho: %q", got)
	}
}

func TestPollInitMarker(t *testing.T) {
	calls := 0
	run := func(_ context.Context, _ time.Duration, name string, args ...string) ([]byte, error) {
		calls++
		switch calls {
		case 1:
			return nil, errors.New("cat: No such file or directory")
		case 2:
			return []byte("0\n"), nil
		case 3:
			return []byte("3"), nil
		}
		return []byte("lixo"), nil
	}
	ctx := context.Background()
	if _, ok := pollInitMarker(ctx, run, "Debian", "/tmp/m"); ok {
		t.Fatal("marcador ausente: ok deveria ser false")
	}
	if code, ok := pollInitMarker(ctx, run, "Debian", "/tmp/m"); !ok || code != 0 {
		t.Fatalf("código 0 = %d, %v", code, ok)
	}
	if code, ok := pollInitMarker(ctx, run, "Debian", "/tmp/m"); !ok || code != 3 {
		t.Fatalf("código 3 = %d, %v", code, ok)
	}
	if _, ok := pollInitMarker(ctx, run, "Debian", "/tmp/m"); ok {
		t.Fatal("conteúdo ilegível: ok deveria ser false")
	}
}

func TestAnswerInitRoutes(t *testing.T) {
	h := &hub{}
	if h.answerInit("Debian", true) {
		t.Fatal("sem pergunta aberta, answerInit deveria devolver false")
	}
	ch := h.awaitInitAnswer("Debian")
	if !h.answerInit("debian", true) { // nome sem distinguir maiúsculas
		t.Fatal("a pergunta aberta deveria receber a resposta")
	}
	select {
	case run := <-ch:
		if !run {
			t.Fatal("a resposta era run=true")
		}
	default:
		t.Fatal("a resposta não chegou")
	}
	if h.answerInit("Debian", false) {
		t.Fatal("resposta duplicada deveria ser ignorada")
	}
	// "continuar assim mesmo" durante o init
	skip := h.awaitInitSkip("Debian")
	if !h.skipInit("Debian") {
		t.Fatal("skipInit deveria achar o init em andamento")
	}
	select {
	case <-skip:
	default:
		t.Fatal("o aviso de continuar não chegou")
	}
	if h.skipInit("Debian") {
		t.Fatal("sem init em andamento, skipInit deveria devolver false")
	}
}

func TestRestoreAnswerEndpoint(t *testing.T) {
	h := &hub{}
	srv := restoreAnswerHandler(h, false)
	post := func(body string) int {
		r := httptest.NewRequest("POST", "/api/restore/answer", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		srv.ServeHTTP(rr, r)
		return rr.Code
	}
	if code := post(`{"distro":"Debian","action":"run"}`); code != http.StatusNotFound {
		t.Fatalf("sem pergunta aberta = %d, quero 404", code)
	}
	ch := h.awaitInitAnswer("Debian")
	if code := post(`{"distro":"Debian","action":"skip"}`); code != http.StatusOK {
		t.Fatalf("resposta válida = %d", code)
	}
	if run := <-ch; run {
		t.Fatal("skip deveria entregar run=false")
	}
	if code := post(`{"distro":"Debian","action":"dança"}`); code != http.StatusBadRequest {
		t.Fatalf("ação inválida = %d", code)
	}
	ro := restoreAnswerHandler(h, true)
	r := httptest.NewRequest("POST", "/api/restore/answer", strings.NewReader(`{"distro":"Debian","action":"run"}`))
	r.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	ro.ServeHTTP(rr, r)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("somente leitura = %d", rr.Code)
	}
}

// fakeInitTerm simula o terminal de inicialização, o wsl.exe e o relógio.
type fakeInitTerm struct {
	clk         time.Time
	openErr     error
	sendErr     error
	sent        []string
	killed      []int
	runCalls    []string
	alive       func(polls int) bool
	markerAfter int // quantas leituras falham antes do marcador existir (-1 = nunca)
	markerBody  string
	reads       int
	aliveChecks int
	skip        chan struct{}
	order       []string
}

func newFakeInitTerm() *fakeInitTerm {
	return &fakeInitTerm{clk: time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC), markerAfter: -1, skip: make(chan struct{}),
		alive: func(int) bool { return true }}
}

func (f *fakeInitTerm) Open(_ context.Context, _ string) (int, error) {
	f.order = append(f.order, "open")
	if f.openErr != nil {
		return 0, f.openErr
	}
	return 77, nil
}
func (f *fakeInitTerm) Send(_ int, data string) error {
	f.order = append(f.order, "send")
	f.sent = append(f.sent, data)
	return f.sendErr
}
func (f *fakeInitTerm) Alive(int) bool {
	f.aliveChecks++
	return f.alive(f.aliveChecks)
}
func (f *fakeInitTerm) Kill(p int) { f.killed = append(f.killed, p) }
func (f *fakeInitTerm) Run(_ context.Context, _ time.Duration, name string, args ...string) ([]byte, error) {
	key := name + " " + strings.Join(args, " ")
	f.runCalls = append(f.runCalls, key)
	if strings.Contains(key, "rm -f") {
		f.order = append(f.order, "rm")
		return nil, nil
	}
	if strings.Contains(key, "--exec cat") {
		f.reads++
		if f.markerAfter >= 0 && f.reads > f.markerAfter {
			return []byte(f.markerBody), nil
		}
		return nil, errors.New("sem marcador")
	}
	return nil, errors.New("comando inesperado: " + key)
}
func (f *fakeInitTerm) Now() time.Time        { return f.clk }
func (f *fakeInitTerm) Sleep(d time.Duration) { f.clk = f.clk.Add(d) }
func (f *fakeInitTerm) Skip() <-chan struct{} { return f.skip }

func TestRunInitOutcomes(t *testing.T) {
	cfg := WSLInitCfg{Enabled: true, Command: "init-wsl2", TimeoutSec: 20}
	ctx := context.Background()

	t.Run("código 0: fecha o terminal, tudo registrado, marcador removido antes", func(t *testing.T) {
		f := newFakeInitTerm()
		f.markerAfter, f.markerBody = 2, "0\n"
		out := runInitTerminal(ctx, f, "Debian", "b1", cfg, nil)
		if !out.Ran || out.ExitCode != 0 || out.Err != "" || out.TimedOut || out.ClosedByUser {
			t.Fatalf("outcome = %+v", out)
		}
		if len(f.killed) != 1 || f.killed[0] != 77 {
			t.Fatalf("o terminal de init deveria fechar: %v", f.killed)
		}
		if len(f.sent) != 1 || f.sent[0] != "init-wsl2; echo $? > /tmp/.bethstudio-init-b1\r" {
			t.Fatalf("linha digitada = %q", f.sent)
		}
		if len(f.order) < 3 || f.order[0] != "rm" || f.order[1] != "open" || f.order[2] != "send" {
			t.Fatalf("ordem = %v, quero rm, open, send", f.order)
		}
	})

	t.Run("código diferente de zero: deixa o terminal aberto e dá o motivo", func(t *testing.T) {
		f := newFakeInitTerm()
		f.markerAfter, f.markerBody = 0, "2"
		out := runInitTerminal(ctx, f, "Debian", "b1", cfg, nil)
		if !out.Ran || out.ExitCode != 2 || !strings.Contains(out.Err, "código 2") {
			t.Fatalf("outcome = %+v", out)
		}
		if len(f.killed) != 0 {
			t.Fatalf("com erro o terminal fica aberto: %v", f.killed)
		}
	})

	t.Run("o usuário fecha o terminal", func(t *testing.T) {
		f := newFakeInitTerm()
		f.alive = func(n int) bool { return n <= 2 } // existia, depois sumiu
		out := runInitTerminal(ctx, f, "Debian", "b1", cfg, nil)
		if !out.ClosedByUser || out.TimedOut || len(f.killed) != 0 {
			t.Fatalf("outcome = %+v killed=%v", out, f.killed)
		}
	})

	t.Run("estoura o tempo máximo e deixa o terminal aberto", func(t *testing.T) {
		f := newFakeInitTerm()
		ticks := 0
		out := runInitTerminal(ctx, f, "Debian", "b1", cfg, func(time.Duration) { ticks++ })
		if !out.TimedOut || len(f.killed) != 0 {
			t.Fatalf("outcome = %+v killed=%v", out, f.killed)
		}
		if waited := f.clk.Sub(time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)); waited < 20*time.Second || waited > 30*time.Second {
			t.Fatalf("esperou %v, quero cerca de 20 s", waited)
		}
		if ticks == 0 {
			t.Fatal("o andamento (tempo corrido) deveria ser informado")
		}
	})

	t.Run("continuar assim mesmo: segue sem esperar e sem fechar", func(t *testing.T) {
		f := newFakeInitTerm()
		close(f.skip)
		out := runInitTerminal(ctx, f, "Debian", "b1", cfg, nil)
		if !out.Ran || out.Err != "" || out.TimedOut || len(f.killed) != 0 {
			t.Fatalf("outcome = %+v", out)
		}
	})

	t.Run("não conseguiu abrir o terminal", func(t *testing.T) {
		f := newFakeInitTerm()
		f.openErr = errors.New("o host não respondeu")
		out := runInitTerminal(ctx, f, "Debian", "b1", cfg, nil)
		if out.Ran || !strings.Contains(out.Err, "o host não respondeu") {
			t.Fatalf("outcome = %+v", out)
		}
	})

	t.Run("contexto cancelado encerra sem travar", func(t *testing.T) {
		f := newFakeInitTerm()
		c, cancel := context.WithCancel(ctx)
		cancel()
		out := runInitTerminal(c, f, "Debian", "b1", cfg, nil)
		if out.TimedOut {
			t.Fatalf("outcome = %+v", out)
		}
	})
}

func TestInitTestBootKeepsItsOwnMarker(t *testing.T) {
	if initMarkerPath(initTestBoot("abc")) == initMarkerPath("abc") {
		t.Fatal("o teste do init não pode usar o marcador da restauração")
	}
	if got := initMarkerPath(initTestBoot("abc")); got != "/tmp/.bethstudio-init-abc-test" {
		t.Fatalf("marcador do teste = %q", got)
	}
}
