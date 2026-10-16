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

	// fluxo do init do WSL
	cfg                    map[string]WSLInitCfg // configuração por distro (chave exata, como nos specs)
	askRun                 map[string]bool       // resposta da pergunta por distro
	askBlock               bool                  // a pergunta nunca é respondida (só o ctx a encerra)
	asked                  []string
	askedMis               map[string][]string
	inits                  []string
	onInit                 func(distro string)
	initOut                initOutcome
	events                 []string // "spawn:<id>", "ask:<distro>", "init:<distro>", na ordem
	sawWindowsBeforeAnswer bool
}

func newFakeEnv() *fakeRestoreEnv {
	return &fakeRestoreEnv{cwds: map[int]string{}, failFor: map[int]error{}, next: 100,
		cfg: map[string]WSLInitCfg{}, askRun: map[string]bool{}, askedMis: map[string][]string{}}
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
	e.events = append(e.events, fmt.Sprintf("spawn:%d", s.PaneID))
	e.cwds[s.PaneID] = cwd
	if err := e.failFor[s.PaneID]; err != nil {
		return 0, err
	}
	e.next++
	return e.next, nil
}

func (e *fakeRestoreEnv) InitConfig(d string) (WSLInitCfg, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	c, ok := e.cfg[d]
	return c, ok
}

func (e *fakeRestoreEnv) hasEvent(ev string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.hasEventLocked(ev)
}

func (e *fakeRestoreEnv) hasEventLocked(ev string) bool {
	for _, x := range e.events {
		if x == ev {
			return true
		}
	}
	return false
}

func (e *fakeRestoreEnv) AskInit(ctx context.Context, d string, missing []string) (bool, error) {
	e.mu.Lock()
	e.asked = append(e.asked, d)
	e.askedMis[d] = append([]string(nil), missing...)
	e.events = append(e.events, "ask:"+d)
	block := e.askBlock
	e.mu.Unlock()
	// a restauração dos terminais que não são WSL não espera pela resposta
	for i := 0; i < 100 && !e.hasEvent("spawn:1"); i++ {
		time.Sleep(5 * time.Millisecond)
	}
	e.mu.Lock()
	e.sawWindowsBeforeAnswer = e.hasEventLocked("spawn:1")
	e.mu.Unlock()
	if block {
		<-ctx.Done()
		return false, ctx.Err()
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.askRun[d], nil
}

func (e *fakeRestoreEnv) RunInit(_ context.Context, d string, _ WSLInitCfg) initOutcome {
	e.mu.Lock()
	e.inits = append(e.inits, d)
	e.events = append(e.events, "init:"+d)
	fn, out := e.onInit, e.initOut
	e.mu.Unlock()
	if fn != nil {
		fn(d)
	}
	return out
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
	dirOK     map[string]bool // chave "distro|path"
	waited    []string
	checked   []string // DirExists: "distro|path"
}

func newFakeGate() *fakeGate {
	return &fakeGate{ensureErr: map[string]error{}, dirOK: map[string]bool{}}
}

func (g *fakeGate) Ensure(_ context.Context, d string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.ensured = append(g.ensured, d)
	return g.ensureErr[d]
}

func (g *fakeGate) DirExists(_ context.Context, d, p string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.checked = append(g.checked, d+"|"+p)
	return g.dirOK[d+"|"+p]
}

func (g *fakeGate) BootID(_ context.Context, d string) string { return "boot-1" }

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

// --- fluxo do init do WSL (pergunta, terminal de inicialização, pendentes) ---

func initCfg() WSLInitCfg { return WSLInitCfg{Enabled: true, Command: "init-wsl2", TimeoutSec: 300} }

func TestRestoreAllDirsOKNeverAsks(t *testing.T) {
	env, gate := newFakeEnv(), newFakeGate()
	env.cfg["Debian"] = initCfg()
	gate.dirOK["Debian|/home/dev"], gate.dirOK["Debian|/mnt/data/app"], gate.dirOK["Ubuntu|/srv"] = true, true, true
	res := runRestore(context.Background(), specsForTest(), env, gate, 1)
	if len(env.asked) != 0 || len(env.inits) != 0 {
		t.Fatalf("com todas as pastas presentes não pergunta nem roda init: asked=%v inits=%v", env.asked, env.inits)
	}
	if len(res.Map) != 5 || len(res.Pending) != 0 {
		t.Fatalf("resultado = %+v", res)
	}
}

func TestRestoreMissingDirAsksAndRunsInit(t *testing.T) {
	env, gate := newFakeEnv(), newFakeGate()
	env.cfg["Debian"] = initCfg()
	env.askRun["Debian"] = true
	gate.dirOK["Debian|/home/dev"], gate.dirOK["Ubuntu|/srv"] = true, true // /mnt/data/app ainda não existe
	env.onInit = func(string) { gate.mu.Lock(); gate.dirOK["Debian|/mnt/data/app"] = true; gate.mu.Unlock() }
	res := runRestore(context.Background(), specsForTest(), env, gate, 1)
	if len(env.asked) != 1 || env.asked[0] != "Debian" || len(env.inits) != 1 {
		t.Fatalf("asked=%v inits=%v, quero 1 pergunta e 1 init para a Debian", env.asked, env.inits)
	}
	if got := env.askedMis["Debian"]; len(got) != 1 || got[0] != "/mnt/data/app" {
		t.Fatalf("pastas ausentes na pergunta = %v", got)
	}
	idx := func(ev string) int {
		for i, x := range env.events {
			if x == ev {
				return i
			}
		}
		return -1
	}
	if idx("init:Debian") < 0 || idx("spawn:3") < idx("init:Debian") {
		t.Fatalf("o terminal 3 só pode abrir depois do init: %v", env.events)
	}
	if len(res.Pending) != 0 || len(res.Map) != 5 || env.cwds[3] != "/mnt/data/app" {
		t.Fatalf("resultado = %+v cwd3=%q", res, env.cwds[3])
	}
}

func TestRestoreSkipInitMakesPending(t *testing.T) {
	env, gate := newFakeEnv(), newFakeGate()
	env.cfg["Debian"] = initCfg()
	env.askRun["Debian"] = false // "Agora não"
	gate.dirOK["Debian|/home/dev"], gate.dirOK["Ubuntu|/srv"] = true, true
	res := runRestore(context.Background(), specsForTest(), env, gate, 1)
	if len(env.inits) != 0 {
		t.Fatalf("init rodou apesar do agora não: %v", env.inits)
	}
	if env.hasEvent("spawn:3") {
		t.Fatal("o terminal com pasta ausente não pode abrir")
	}
	if len(res.Pending) != 1 || res.Pending[0].PaneID != 3 || res.Pending[0].Distro != "Debian" || res.Pending[0].Cwd != "/mnt/data/app" {
		t.Fatalf("pendentes = %+v", res.Pending)
	}
	if res.Pending[0].Spec.PaneID != 3 || len(res.Failed) != 0 || len(res.Map) != 4 {
		t.Fatalf("resultado = %+v", res)
	}
	if !env.sawWindowsBeforeAnswer {
		t.Fatal("o terminal que não é WSL deveria abrir sem esperar a resposta")
	}
}

func TestRestoreInitDoesNotFixDirStaysPending(t *testing.T) {
	env, gate := newFakeEnv(), newFakeGate()
	env.cfg["Debian"] = initCfg()
	env.askRun["Debian"] = true
	env.initOut = initOutcome{Ran: true, ExitCode: 2, Err: "o comando saiu com código 2"}
	gate.dirOK["Debian|/home/dev"], gate.dirOK["Ubuntu|/srv"] = true, true
	res := runRestore(context.Background(), specsForTest(), env, gate, 1)
	if len(res.Pending) != 1 || res.Pending[0].PaneID != 3 {
		t.Fatalf("pendentes = %+v", res.Pending)
	}
	if len(res.Warnings) == 0 {
		t.Fatal("o init com erro deveria virar aviso")
	}
}

func TestRestoreNoInitConfiguredGoesPending(t *testing.T) {
	env, gate := newFakeEnv(), newFakeGate()
	gate.dirOK["Debian|/home/dev"], gate.dirOK["Ubuntu|/srv"] = true, true
	res := runRestore(context.Background(), specsForTest(), env, gate, 1)
	if len(env.asked) != 0 {
		t.Fatalf("sem init configurado não há pergunta: %v", env.asked)
	}
	if len(res.Pending) != 1 || res.Pending[0].PaneID != 3 || env.hasEvent("spawn:3") {
		t.Fatalf("pendentes = %+v events=%v", res.Pending, env.events)
	}
}

func TestRestoreDisabledInitDoesNotAsk(t *testing.T) {
	env, gate := newFakeEnv(), newFakeGate()
	env.cfg["Debian"] = WSLInitCfg{Enabled: false, Command: "init-wsl2"}
	gate.dirOK["Debian|/home/dev"], gate.dirOK["Ubuntu|/srv"] = true, true
	res := runRestore(context.Background(), specsForTest(), env, gate, 1)
	if len(env.asked) != 0 || len(res.Pending) != 1 {
		t.Fatalf("asked=%v pendentes=%+v", env.asked, res.Pending)
	}
}

func TestRestoreTwoDistrosAskedIndependently(t *testing.T) {
	env, gate := newFakeEnv(), newFakeGate()
	env.cfg["Debian"], env.cfg["Ubuntu"] = initCfg(), initCfg()
	env.askRun["Debian"], env.askRun["Ubuntu"] = true, false
	gate.dirOK["Debian|/home/dev"] = true // /mnt/data/app (Debian) e /srv (Ubuntu) ausentes
	env.onInit = func(d string) {
		if d == "Debian" {
			gate.mu.Lock()
			gate.dirOK["Debian|/mnt/data/app"] = true
			gate.mu.Unlock()
		}
	}
	res := runRestore(context.Background(), specsForTest(), env, gate, 1)
	if len(env.asked) != 2 || len(env.inits) != 1 || env.inits[0] != "Debian" {
		t.Fatalf("asked=%v inits=%v", env.asked, env.inits)
	}
	if len(res.Pending) != 1 || res.Pending[0].PaneID != 4 || res.Pending[0].Distro != "Ubuntu" {
		t.Fatalf("só o da Ubuntu fica pendente: %+v", res.Pending)
	}
	if _, ok := res.Map[3]; !ok {
		t.Fatalf("o terminal 3 (Debian) deveria ter aberto: %v", res.Map)
	}
}

func TestRestoreAskNeverAnsweredStopsOnCancel(t *testing.T) {
	env, gate := newFakeEnv(), newFakeGate()
	env.cfg["Debian"] = initCfg()
	env.askBlock = true
	gate.dirOK["Debian|/home/dev"], gate.dirOK["Ubuntu|/srv"] = true, true
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	done := make(chan restoreResult, 1)
	go func() { done <- runRestore(ctx, specsForTest(), env, gate, 1) }()
	select {
	case <-done:
		if !env.hasEvent("spawn:1") {
			t.Fatal("o terminal que não é WSL já deveria ter aberto")
		}
		if env.hasEvent("spawn:3") {
			t.Fatal("o terminal com pasta ausente não pode abrir sem resposta")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("runRestore não terminou depois do cancelamento")
	}
}

func TestRestoreInitAskedOncePerDistro(t *testing.T) {
	env, gate := newFakeEnv(), newFakeGate()
	env.cfg["Debian"] = initCfg()
	env.askRun["Debian"] = false
	gate.dirOK["Ubuntu|/srv"] = true // as pastas 2 e 3 da Debian faltam
	runRestore(context.Background(), specsForTest(), env, gate, 1)
	if len(env.asked) != 1 {
		t.Fatalf("uma pergunta por distro: %v", env.asked)
	}
	if got := env.askedMis["Debian"]; len(got) != 2 {
		t.Fatalf("a pergunta lista as duas pastas: %v", got)
	}
}

func TestRestoreAskStageCarriesMissingFolders(t *testing.T) {
	env, gate := newFakeEnv(), newFakeGate()
	env.cfg["Debian"] = initCfg()
	gate.dirOK["Debian|/home/dev"], gate.dirOK["Ubuntu|/srv"] = true, true
	runRestore(context.Background(), specsForTest(), env, gate, 1)
	found := false
	for _, p := range env.progress {
		if p.Stage == "ask_init" && p.Distro == "Debian" && len(p.Missing) == 1 && p.Missing[0] == "/mnt/data/app" {
			found = true
		}
	}
	if !found {
		t.Fatalf("falta o estágio ask_init com a pasta ausente: %+v", env.progress)
	}
}

func TestRestoreCancelKeepsUnspawnedTerminalsAsPending(t *testing.T) {
	env, gate := newFakeEnv(), newFakeGate()
	env.cfg["Debian"] = initCfg()
	env.askBlock = true
	gate.dirOK["Debian|/home/dev"], gate.dirOK["Ubuntu|/srv"] = true, true // /mnt/data/app ausente
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	res := runRestore(ctx, specsForTest(), env, gate, 1)
	ids := map[int]bool{}
	for _, p := range res.Pending {
		ids[p.PaneID] = true
	}
	if !ids[2] || !ids[3] {
		t.Fatalf("os terminais da Debian (bloqueados pela pergunta) não podem se perder: pendentes = %+v", res.Pending)
	}
	for id := range res.Map {
		if ids[id] {
			t.Fatalf("o terminal %d abriu e também ficou pendente", id)
		}
	}
}
