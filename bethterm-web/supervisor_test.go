package main

import (
	"errors"
	"strings"
	"testing"
	"time"
)

type fakeHostCtl struct {
	running  bool
	gui      bool
	startErr error
	starts   int
	quits    []string
}

func (f *fakeHostCtl) Running() bool    { return f.running }
func (f *fakeHostCtl) GUIRunning() bool { return f.gui }
func (f *fakeHostCtl) Start() error {
	f.starts++
	if f.startErr != nil {
		return f.startErr
	}
	f.running = true
	return nil
}
func (f *fakeHostCtl) RequestQuit(who string) error {
	f.quits = append(f.quits, who)
	f.running = false
	return nil
}

type testClock struct{ t time.Time }

func (c *testClock) now() time.Time          { return c.t }
func (c *testClock) advance(d time.Duration) { c.t = c.t.Add(d) }

func newTestSupervisor(t *testing.T, ctl hostCtl) (*supervisor, *testClock, *[]hostState) {
	t.Setenv("BETHTERM_DATA_DIR", t.TempDir()) // o supervisor escreve no host-life.log
	clk := &testClock{t: time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)}
	var seen []hostState
	s := newSupervisor(ctl, newRestartLimiter(3, 10*time.Minute), clk.now, func(st hostState, _ string) { seen = append(seen, st) })
	return s, clk, &seen
}

func TestSupervisorStartsAbsentHost(t *testing.T) {
	ctl := &fakeHostCtl{}
	s, _, _ := newTestSupervisor(t, ctl)
	s.Tick()
	if ctl.starts != 1 {
		t.Fatalf("starts = %d, quero 1", ctl.starts)
	}
	if st, _ := s.State(); st != hostRunning {
		t.Fatalf("estado = %s, quero running", st)
	}
}

func TestSupervisorLeavesRunningHostAlone(t *testing.T) {
	ctl := &fakeHostCtl{running: true}
	s, _, _ := newTestSupervisor(t, ctl)
	s.Tick()
	s.Tick()
	if ctl.starts != 0 {
		t.Fatalf("não deveria iniciar um host que já roda (starts=%d)", ctl.starts)
	}
}

func TestSupervisorDoesNotRestartAfterQuitAsked(t *testing.T) {
	ctl := &fakeHostCtl{running: true}
	s, _, _ := newTestSupervisor(t, ctl)
	s.AskQuit()
	ctl.running = false // o host saiu a pedido do usuário
	s.Tick()
	if ctl.starts != 0 {
		t.Fatalf("depois de Encerrar tudo o host não pode voltar (starts=%d)", ctl.starts)
	}
	if st, _ := s.State(); st != hostQuitting {
		t.Fatalf("estado = %s, quero quitting", st)
	}
}

func TestSupervisorStopsAfterThreeRestartsInTenMinutes(t *testing.T) {
	ctl := &fakeHostCtl{}
	s, clk, _ := newTestSupervisor(t, ctl)
	for i := 0; i < 6; i++ {
		ctl.running = false // o host morre de novo a cada ciclo
		s.Tick()
		clk.advance(time.Minute)
	}
	if ctl.starts != 4 {
		t.Fatalf("starts = %d, quero 4 (o primeiro start mais 3 reinícios)", ctl.starts)
	}
	st, msg := s.State()
	if st != hostUnavailable || !strings.Contains(msg, "3") {
		t.Fatalf("estado = %s %q, quero unavailable citando o limite", st, msg)
	}
}

func TestSupervisorRetryResetsTheLimit(t *testing.T) {
	ctl := &fakeHostCtl{}
	s, _, _ := newTestSupervisor(t, ctl)
	for i := 0; i < 5; i++ {
		ctl.running = false
		s.Tick()
	}
	if st, _ := s.State(); st != hostUnavailable {
		t.Fatalf("pré-condição: estado = %s", st)
	}
	ctl.running = false
	s.Retry()
	if ctl.starts != 5 {
		t.Fatalf("Retry deveria tentar de novo (starts=%d)", ctl.starts)
	}
}

func TestSupervisorStartFailureCountsAndShowsReason(t *testing.T) {
	ctl := &fakeHostCtl{startErr: errors.New("bethterm-host.exe não encontrado")}
	s, _, _ := newTestSupervisor(t, ctl)
	s.Tick()
	st, msg := s.State()
	if st != hostStarting || !strings.Contains(msg, "não encontrado") {
		t.Fatalf("estado = %s %q", st, msg)
	}
	s.Tick()
	s.Tick()
	s.Tick()
	s.Tick()
	if ctl.starts != 4 {
		t.Fatalf("falhas contam para o limite (menos a primeira): starts = %d, quero 4", ctl.starts)
	}
	if st, _ := s.State(); st != hostUnavailable {
		t.Fatalf("estado = %s, quero unavailable", st)
	}
}

func TestSupervisorYieldsToTheOldGUI(t *testing.T) {
	ctl := &fakeHostCtl{gui: true}
	s, _, _ := newTestSupervisor(t, ctl)
	s.Tick()
	if ctl.starts != 0 {
		t.Fatalf("com a GUI antiga rodando o Studio não supervisiona (starts=%d)", ctl.starts)
	}
	if st, _ := s.State(); st != hostGUIManaged {
		t.Fatalf("estado = %s, quero gui-managed", st)
	}
	ctl.gui = false
	ctl.running = true
	s.Tick()
	if st, _ := s.State(); st != hostRunning {
		t.Fatalf("depois que a GUI saiu: estado = %s, quero running", st)
	}
}

func TestSupervisorReportsOnlyChanges(t *testing.T) {
	ctl := &fakeHostCtl{running: true}
	s, _, seen := newTestSupervisor(t, ctl)
	for i := 0; i < 5; i++ {
		s.Tick()
	}
	if len(*seen) != 1 {
		t.Fatalf("onState chamado %d vezes, quero 1 (só mudanças)", len(*seen))
	}
}
