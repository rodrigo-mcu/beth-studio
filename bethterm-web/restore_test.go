package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeRestoreEnv struct {
	mu       sync.Mutex
	order    []int          // pane ids antigos, na ordem em que chegaram ao Spawn
	cwds     map[int]string // cwd com que cada um foi aberto
	failFor  map[int]error  // falha por id antigo
	next     int            // próximo id novo
	progress []restoreProgress
	cur, max int32
}

func newFakeEnv() *fakeRestoreEnv {
	return &fakeRestoreEnv{cwds: map[int]string{}, failFor: map[int]error{}, next: 100}
}

func (e *fakeRestoreEnv) Spawn(_ context.Context, s paneSpec, cwd string) (int, error) {
	c := atomic.AddInt32(&e.cur, 1)
	for {
		m := atomic.LoadInt32(&e.max)
		if c <= m || atomic.CompareAndSwapInt32(&e.max, m, c) {
			break
		}
	}
	time.Sleep(3 * time.Millisecond)
	atomic.AddInt32(&e.cur, -1)
	e.mu.Lock()
	defer e.mu.Unlock()
	e.order = append(e.order, s.PaneID)
	e.cwds[s.PaneID] = cwd
	if err := e.failFor[s.PaneID]; err != nil {
		return 0, err
	}
	e.next++
	return e.next, nil
}

func (e *fakeRestoreEnv) Progress(p restoreProgress) {
	e.mu.Lock()
	e.progress = append(e.progress, p)
	e.mu.Unlock()
}

type fakeGate struct {
	mu        sync.Mutex
	ensured   []string
	ensureErr map[string]error
	initErr   map[string]error
	dirOK     map[string]bool // chave "distro|path"
	waited    []string
}

func newFakeGate() *fakeGate {
	return &fakeGate{ensureErr: map[string]error{}, initErr: map[string]error{}, dirOK: map[string]bool{}}
}

func (g *fakeGate) Ensure(_ context.Context, d string) (error, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.ensured = append(g.ensured, d)
	return g.initErr[d], g.ensureErr[d]
}

func (g *fakeGate) WaitDir(_ context.Context, d, p string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.waited = append(g.waited, d+"|"+p)
	return g.dirOK[d+"|"+p]
}

func specsForTest() []paneSpec {
	return []paneSpec{
		{PaneID: 1, Kind: "powershell", ShellID: "powershell", Cwd: `C:\work`, Order: 0},
		{PaneID: 2, Kind: "wsl", ShellID: "wsl.default", Distro: "Debian", Cwd: "/home/dev", Order: 1},
		{PaneID: 3, Kind: "wsl", ShellID: "wsl.default", Distro: "Debian", Cwd: "/mnt/data/app", Order: 2},
		{PaneID: 4, Kind: "wsl", ShellID: "wsl.default", Distro: "Ubuntu", Cwd: "/srv", Order: 3},
		{PaneID: 5, Kind: "ssh", Tool: &toolSpec{Kind: "ssh", ID: "abc"}, Order: 4},
	}
}

func TestRunRestoreSpawnsInOrderAndMapsIDs(t *testing.T) {
	env, gate := newFakeEnv(), newFakeGate()
	gate.dirOK["Debian|/home/dev"], gate.dirOK["Debian|/mnt/data/app"], gate.dirOK["Ubuntu|/srv"] = true, true, true
	res := runRestore(context.Background(), specsForTest(), env, gate, 1)
	if len(res.Failed) != 0 || len(res.Map) != 5 {
		t.Fatalf("resultado = %+v", res)
	}
	for i, id := range []int{1, 2, 3, 4, 5} {
		if env.order[i] != id {
			t.Fatalf("ordem de spawn = %v, quero [1 2 3 4 5]", env.order)
		}
	}
	if res.Map[1] != 101 || res.Map[5] != 105 {
		t.Fatalf("mapa = %v", res.Map)
	}
}

func TestRunRestoreEnsuresEachDistroOnce(t *testing.T) {
	env, gate := newFakeEnv(), newFakeGate()
	gate.dirOK["Debian|/home/dev"], gate.dirOK["Debian|/mnt/data/app"], gate.dirOK["Ubuntu|/srv"] = true, true, true
	runRestore(context.Background(), specsForTest(), env, gate, 2)
	if len(gate.ensured) != 2 {
		t.Fatalf("Ensure chamado para %v, quero uma vez por distro (Debian e Ubuntu)", gate.ensured)
	}
}

func TestRunRestoreMissingDirFallsBackToHome(t *testing.T) {
	env, gate := newFakeEnv(), newFakeGate()
	gate.dirOK["Debian|/home/dev"] = true // /mnt/data/app nunca aparece
	gate.dirOK["Ubuntu|/srv"] = true
	res := runRestore(context.Background(), specsForTest(), env, gate, 1)
	if env.cwds[3] != "" {
		t.Fatalf("pasta ausente deve abrir sem pasta (home), abriu em %q", env.cwds[3])
	}
	if env.cwds[2] != "/home/dev" {
		t.Fatalf("pasta existente deve ser mantida, abriu em %q", env.cwds[2])
	}
	if len(res.Fallbacks) != 1 || res.Fallbacks[0].PaneID != 3 {
		t.Fatalf("fallbacks = %+v, quero só o terminal 3", res.Fallbacks)
	}
	if _, ok := res.Map[3]; !ok {
		t.Fatal("o terminal 3 deveria ter sido recriado mesmo assim")
	}
}

func TestRunRestoreOneFailureDoesNotStopTheOthers(t *testing.T) {
	env, gate := newFakeEnv(), newFakeGate()
	gate.dirOK["Debian|/home/dev"], gate.dirOK["Debian|/mnt/data/app"], gate.dirOK["Ubuntu|/srv"] = true, true, true
	env.failFor[2] = errors.New("spawn: shell desconhecido")
	res := runRestore(context.Background(), specsForTest(), env, gate, 1)
	if len(res.Failed) != 1 || res.Failed[0].PaneID != 2 || res.Failed[0].Reason == "" {
		t.Fatalf("falhas = %+v, quero só o 2 com motivo", res.Failed)
	}
	if len(res.Map) != 4 {
		t.Fatalf("mapa = %v, quero 4 terminais recriados", res.Map)
	}
	if _, ok := res.Map[2]; ok {
		t.Fatal("o terminal que falhou não pode estar no mapa")
	}
}

func TestRunRestoreDistroThatNeverStartsFailsOnlyItsTerminals(t *testing.T) {
	env, gate := newFakeEnv(), newFakeGate()
	gate.ensureErr["Debian"] = errors.New("a distro Debian não respondeu em 60 s")
	gate.dirOK["Ubuntu|/srv"] = true
	res := runRestore(context.Background(), specsForTest(), env, gate, 1)
	failed := map[int]bool{}
	for _, f := range res.Failed {
		failed[f.PaneID] = true
	}
	if !failed[2] || !failed[3] || len(failed) != 2 {
		t.Fatalf("deveriam falhar só os da Debian (2 e 3): %+v", res.Failed)
	}
	for _, id := range []int{1, 4, 5} {
		if _, ok := res.Map[id]; !ok {
			t.Fatalf("o terminal %d deveria ter sido recriado: %v", id, res.Map)
		}
	}
}

func TestRunRestoreInitFailureIsAWarningOnly(t *testing.T) {
	env, gate := newFakeEnv(), newFakeGate()
	gate.initErr["Debian"] = errors.New("o comando de inicialização de Debian falhou")
	gate.dirOK["Debian|/home/dev"], gate.dirOK["Debian|/mnt/data/app"], gate.dirOK["Ubuntu|/srv"] = true, true, true
	res := runRestore(context.Background(), specsForTest(), env, gate, 1)
	if len(res.Failed) != 0 || len(res.Map) != 5 {
		t.Fatalf("falha de init não pode impedir a restauração: %+v", res)
	}
	if len(res.Warnings) == 0 {
		t.Fatal("a falha do init deveria virar aviso")
	}
}

func TestRunRestoreNonWSLNeverTouchesTheGate(t *testing.T) {
	env, gate := newFakeEnv(), newFakeGate()
	specs := []paneSpec{
		{PaneID: 1, Kind: "powershell", ShellID: "powershell", Cwd: `C:\x`},
		{PaneID: 2, Kind: "wsl", ShellID: "wsl.default", Distro: "", Cwd: "/home/x"}, // distro desconhecida: sem gate
	}
	runRestore(context.Background(), specs, env, gate, 1)
	if len(gate.ensured) != 0 || len(gate.waited) != 0 {
		t.Fatalf("gate usado sem necessidade: ensure=%v wait=%v", gate.ensured, gate.waited)
	}
	if env.cwds[2] != "/home/x" {
		t.Fatalf("sem gate a pasta é mantida: %q", env.cwds[2])
	}
}

func TestRunRestoreProgressIsMonotonicAndEndsComplete(t *testing.T) {
	env, gate := newFakeEnv(), newFakeGate()
	gate.dirOK["Debian|/home/dev"], gate.dirOK["Debian|/mnt/data/app"], gate.dirOK["Ubuntu|/srv"] = true, true, true
	env.failFor[3] = errors.New("falhou")
	runRestore(context.Background(), specsForTest(), env, gate, 3)
	if len(env.progress) == 0 {
		t.Fatal("sem progresso")
	}
	last := -1
	for _, p := range env.progress {
		if p.Total != 5 {
			t.Fatalf("Total = %d, quero 5: %+v", p.Total, p)
		}
		if p.Done < last {
			t.Fatalf("progresso andou para trás: %v", env.progress)
		}
		last = p.Done
	}
	if last != 5 {
		t.Fatalf("o progresso deveria terminar em 5 de 5, terminou em %d", last)
	}
}

func TestRunRestoreProgressMentionsWaitingForWSL(t *testing.T) {
	env, gate := newFakeEnv(), newFakeGate()
	gate.dirOK["Debian|/home/dev"] = true
	runRestore(context.Background(), []paneSpec{specsForTest()[1]}, env, gate, 1)
	found := false
	for _, p := range env.progress {
		if p.Stage == "wsl" && p.Distro == "Debian" {
			found = true
		}
	}
	if !found {
		t.Fatalf("faltou o progresso 'aguardando o WSL (Debian)': %v", env.progress)
	}
}

func TestRunRestoreRespectsTheParallelLimit(t *testing.T) {
	env, gate := newFakeEnv(), newFakeGate()
	var specs []paneSpec
	for i := 1; i <= 12; i++ {
		specs = append(specs, paneSpec{PaneID: i, Kind: "cmd", ShellID: "cmd", Order: i})
	}
	runRestore(context.Background(), specs, env, gate, 3)
	if env.max > 3 || env.max < 1 {
		t.Fatalf("máximo de spawns simultâneos = %d, quero entre 1 e 3", env.max)
	}
	if len(env.order) != 12 {
		t.Fatalf("spawns = %d, quero 12", len(env.order))
	}
}

func TestRunRestoreCancelledBeforeStartDoesNothing(t *testing.T) {
	env, gate := newFakeEnv(), newFakeGate()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	res := runRestore(ctx, specsForTest(), env, gate, 2)
	if len(env.order) != 0 || len(res.Map) != 0 {
		t.Fatalf("cancelado: não deveria abrir nada (abriu %v)", env.order)
	}
}

func TestRestoreFailureReasonKeepsTitle(t *testing.T) {
	env, gate := newFakeEnv(), newFakeGate()
	env.failFor[1] = fmt.Errorf("spawn: %w", errors.New("timeout"))
	specs := []paneSpec{{PaneID: 1, Kind: "cmd", ShellID: "cmd", Title: "build"}}
	res := runRestore(context.Background(), specs, env, gate, 1)
	if len(res.Failed) != 1 || res.Failed[0].Title != "build" {
		t.Fatalf("falha deve levar o título para a interface: %+v", res.Failed)
	}
}
