package main

import (
	"sync"
	"testing"
	"time"
)

type coordHarness struct {
	mu       sync.Mutex
	now      time.Time
	host     string
	active   bool
	file     specsFile
	haveFile bool
	saved    []specsFile
	frozen   []bool
	started  []specsFile
	built    []paneSpec
}

func newCoordHarness() *coordHarness {
	return &coordHarness{now: time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC), host: "200@2", active: true,
		built: []paneSpec{{PaneID: 1, ShellID: "cmd", Kind: "cmd", Cwd: `C:\a`}}}
}

func (h *coordHarness) deps() coordDeps {
	return coordDeps{
		hostID: func() string { h.mu.Lock(); defer h.mu.Unlock(); return h.host },
		now:    func() time.Time { h.mu.Lock(); defer h.mu.Unlock(); return h.now },
		loadSpecs: func() (specsFile, bool) {
			h.mu.Lock()
			defer h.mu.Unlock()
			return h.file, h.haveFile
		},
		saveSpecs: func(f specsFile) error {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.saved = append(h.saved, f)
			h.file, h.haveFile = f, true
			return nil
		},
		buildSpecs: func([]byte) []paneSpec { h.mu.Lock(); defer h.mu.Unlock(); return h.built },
		freeze:     func(on bool) { h.mu.Lock(); h.frozen = append(h.frozen, on); h.mu.Unlock() },
		active:     func() bool { h.mu.Lock(); defer h.mu.Unlock(); return h.active },
		start:      func(f specsFile) { h.mu.Lock(); h.started = append(h.started, f); h.mu.Unlock() },
	}
}

func (h *coordHarness) setFile(host string, ageHours int, specs ...paneSpec) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.file = specsFile{Version: 1, HostID: host, SavedAt: h.now.Add(-time.Duration(ageHours) * time.Hour).Format(time.RFC3339), Specs: specs}
	h.haveFile = true
}

const listEmpty = `{"ev":"list","panes":[]}`
const listTwo = `{"ev":"list","panes":[{"pane_id":1},{"pane_id":2}]}`

func newTestCoordinator(h *coordHarness) *restoreCoordinator {
	c := newRestoreCoordinator(h.deps())
	c.saveDelay, c.emptySaveDelay, c.minRewrite = 0, 0, 0 // nos testes a gravação é imediata
	c.retryDelay, c.maxRetries = 2*time.Millisecond, 5
	return c
}

func TestCoordinatorRestoresWhenTheHostChangedAndIsEmpty(t *testing.T) {
	h := newCoordHarness()
	h.setFile("100@1", 1, paneSpec{PaneID: 1, ShellID: "cmd", Kind: "cmd"})
	c := newTestCoordinator(h)
	c.onList([]byte(listEmpty))
	c.waitIdle()
	if len(h.started) != 1 {
		t.Fatalf("restauração iniciada %d vezes, quero 1", len(h.started))
	}
	if len(h.frozen) != 1 || !h.frozen[0] {
		t.Fatalf("o reconcile deveria ter sido congelado antes de restaurar: %v", h.frozen)
	}
	if len(h.saved) != 0 {
		t.Fatal("não pode sobrescrever a receita enquanto vai restaurar")
	}
}

func TestCoordinatorDoesNotRestoreTwiceWhileRunning(t *testing.T) {
	h := newCoordHarness()
	h.setFile("100@1", 1, paneSpec{PaneID: 1, ShellID: "cmd", Kind: "cmd"})
	c := newTestCoordinator(h)
	c.onList([]byte(listEmpty))
	c.onList([]byte(listEmpty))
	c.onList([]byte(listTwo)) // chegando terminais novos durante a restauração
	c.waitIdle()
	if len(h.started) != 1 {
		t.Fatalf("restauração iniciada %d vezes, quero 1", len(h.started))
	}
	if len(h.saved) != 0 {
		t.Fatal("durante a restauração a receita não pode ser regravada")
	}
}

func TestCoordinatorEmptyListFromSameHostDoesNotRestore(t *testing.T) {
	h := newCoordHarness()
	h.setFile("200@2", 1, paneSpec{PaneID: 1, ShellID: "cmd", Kind: "cmd"}) // mesmo host
	c := newTestCoordinator(h)
	c.onList([]byte(listEmpty))
	c.waitIdle()
	if len(h.started) != 0 {
		t.Fatal("usuário fechou tudo: não pode ressuscitar os terminais")
	}
	if len(h.saved) != 1 || len(h.saved[0].Specs) != 0 {
		t.Fatalf("a receita deveria passar a ser vazia: %+v", h.saved)
	}
}

func TestCoordinatorSavesSpecsWithTheCurrentHost(t *testing.T) {
	h := newCoordHarness()
	c := newTestCoordinator(h)
	c.onList([]byte(listTwo))
	c.waitIdle()
	if len(h.saved) != 1 || h.saved[0].HostID != "200@2" || len(h.saved[0].Specs) != 1 {
		t.Fatalf("receita gravada = %+v", h.saved)
	}
}

func TestCoordinatorNeverSavesWithoutHostIdentity(t *testing.T) {
	h := newCoordHarness()
	h.host = ""
	c := newTestCoordinator(h)
	c.onList([]byte(listTwo))
	c.onList([]byte(listEmpty))
	c.waitIdle()
	if len(h.saved) != 0 || len(h.started) != 0 {
		t.Fatalf("sem identidade do host nada pode ser gravado nem restaurado: %+v %+v", h.saved, h.started)
	}
}

func TestCoordinatorInactiveWhenTheOldGUIManages(t *testing.T) {
	h := newCoordHarness()
	h.active = false
	h.setFile("100@1", 1, paneSpec{PaneID: 1})
	c := newTestCoordinator(h)
	c.onList([]byte(listEmpty))
	c.onList([]byte(listTwo))
	c.waitIdle()
	if len(h.started) != 0 || len(h.saved) != 0 || len(h.frozen) != 0 {
		t.Fatal("com a GUI antiga cuidando do host o coordenador não faz nada")
	}
}

func TestCoordinatorStaleSpecsDoNotRestore(t *testing.T) {
	h := newCoordHarness()
	h.setFile("100@1", 24*8, paneSpec{PaneID: 1, ShellID: "cmd", Kind: "cmd"}) // 8 dias
	c := newTestCoordinator(h)
	c.onList([]byte(listEmpty))
	c.waitIdle()
	if len(h.started) != 0 {
		t.Fatal("receita velha não restaura")
	}
}

func TestCoordinatorStructuralKeyIgnoresTitleChanges(t *testing.T) {
	a := []paneSpec{{PaneID: 1, ShellID: "cmd", Cwd: `C:\a`, Title: "um"}}
	b := []paneSpec{{PaneID: 1, ShellID: "cmd", Cwd: `C:\a`, Title: "outro"}}
	if structKey(a) != structKey(b) {
		t.Fatal("mudar só o título (spinner de agente) não é mudança estrutural")
	}
	c := []paneSpec{{PaneID: 1, ShellID: "cmd", Cwd: `C:\b`}}
	if structKey(a) == structKey(c) {
		t.Fatal("mudar a pasta é mudança estrutural")
	}
}

func TestCoordinatorFinishedAllowsSavingAgain(t *testing.T) {
	h := newCoordHarness()
	h.setFile("100@1", 1, paneSpec{PaneID: 1, ShellID: "cmd", Kind: "cmd"})
	c := newTestCoordinator(h)
	c.onList([]byte(listEmpty))
	c.waitIdle()
	h.mu.Lock()
	h.host = "300@3" // depois da restauração o host atual é o novo
	h.mu.Unlock()
	c.finished()
	c.onList([]byte(listTwo))
	c.waitIdle()
	if len(h.saved) != 1 || h.saved[0].HostID != "300@3" {
		t.Fatalf("depois de terminar, a receita deve ser regravada para o host novo: %+v", h.saved)
	}
}

func TestCoordinatorHostIdentityArrivesLate(t *testing.T) {
	h := newCoordHarness()
	h.host = "" // o host.pid ainda não existe
	h.setFile("100@1", 1, paneSpec{PaneID: 1, ShellID: "cmd", Kind: "cmd"})
	c := newTestCoordinator(h)
	c.retryDelay = 50 * time.Millisecond // dá tempo de olhar o estado intermediário
	c.onList([]byte(listEmpty))
	h.mu.Lock()
	if len(h.frozen) != 1 || !h.frozen[0] {
		h.mu.Unlock()
		t.Fatalf("sem identidade e com receita aproveitável o reconcile deve ficar congelado: %v", h.frozen)
	}
	h.host = "200@2" // a identidade aparece
	h.mu.Unlock()
	c.waitIdle()
	if len(h.started) != 1 {
		t.Fatalf("depois que a identidade apareceu deveria restaurar (iniciou %d vezes)", len(h.started))
	}
	if len(h.saved) != 0 {
		t.Fatal("não pode sobrescrever a receita")
	}
}

func TestCoordinatorHostIdentityNeverArrivesUnfreezes(t *testing.T) {
	h := newCoordHarness()
	h.host = ""
	h.setFile("100@1", 1, paneSpec{PaneID: 1, ShellID: "cmd", Kind: "cmd"})
	c := newTestCoordinator(h)
	c.onList([]byte(listEmpty))
	c.waitIdle()
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.started) != 0 {
		t.Fatal("sem identidade nunca decide restaurar")
	}
	if len(h.frozen) != 2 || !h.frozen[0] || h.frozen[1] {
		t.Fatalf("esgotadas as tentativas o reconcile deve ser liberado: %v", h.frozen)
	}
}

func TestCoordinatorLateIdentityButNothingToRestoreUnfreezes(t *testing.T) {
	h := newCoordHarness()
	h.host = ""
	h.setFile("200@2", 1, paneSpec{PaneID: 1, ShellID: "cmd", Kind: "cmd"}) // receita do mesmo host que vai aparecer
	c := newTestCoordinator(h)
	c.retryDelay = 50 * time.Millisecond
	c.onList([]byte(listEmpty))
	h.mu.Lock()
	h.host = "200@2"
	h.mu.Unlock()
	c.waitIdle()
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.started) != 0 {
		t.Fatal("mesmo host: não restaura")
	}
	if len(h.frozen) != 2 || !h.frozen[0] || h.frozen[1] {
		t.Fatalf("descongela quando não há o que restaurar: %v", h.frozen)
	}
}

func TestCoordinatorNoFreezeWithoutUsableSpecsWhileIdentityUnknown(t *testing.T) {
	h := newCoordHarness()
	h.host = ""
	c := newTestCoordinator(h) // sem receita
	c.onList([]byte(listEmpty))
	c.waitIdle()
	if len(h.frozen) != 0 {
		t.Fatalf("sem receita não há por que congelar o reconcile: %v", h.frozen)
	}
}

func TestCoordinatorKeepsTheFolderOfABrokenWSLTerminal(t *testing.T) {
	h := newCoordHarness()
	h.built = []paneSpec{{PaneID: 7, Kind: "wsl", ShellID: "wsl.default", Cwd: "/", Title: "wslhost.exe"}}
	c := newTestCoordinator(h)
	c.setCarry(map[int]string{7: "/mnt/kingston/mcu/repo/rxppro"})
	c.onList([]byte(listTwo))
	c.waitIdle()
	if len(h.saved) != 1 || h.saved[0].Specs[0].Cwd != "/mnt/kingston/mcu/repo/rxppro" {
		t.Fatalf("a receita perdeu a pasta de trabalho: %+v", h.saved)
	}
	// o shell subiu: a pasta viva vale
	h.mu.Lock()
	h.built = []paneSpec{{PaneID: 7, Kind: "wsl", ShellID: "wsl.default", Cwd: "/home/r", Title: "r@pc: ~"}}
	h.mu.Unlock()
	c.onList([]byte(listTwo))
	c.waitIdle()
	last := h.saved[len(h.saved)-1]
	if last.Specs[0].Cwd != "/home/r" {
		t.Fatalf("receita = %+v", last)
	}
}
