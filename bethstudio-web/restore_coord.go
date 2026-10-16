package main

// restore_coord.go — decide QUANDO restaurar e mantém a receita dos
// terminais em dia. Chamado a cada lista da bridge, antes do reconcile:
//
//   - host novo (outro processo), lista vazia e receita aproveitável: congela
//     o reconcile e dispara a restauração;
//   - caso contrário, grava a receita (com debounce), sem nunca sobrescrever
//     com lista vazia de um host que acabou de subir.

import (
	"fmt"
	"log"
	"strings"
	"sync"
	"time"
)

type coordDeps struct {
	hostID     func() string
	now        func() time.Time
	loadSpecs  func() (specsFile, bool)
	saveSpecs  func(specsFile) error
	buildSpecs func(list []byte) []paneSpec
	freeze     func(on bool)
	// active: false quando a GUI antiga supervisiona o host
	active func() bool
	// start roda a restauração (em goroutine própria) e chama finished() no fim
	start func(file specsFile)
}

type pendingSave struct {
	list []byte
	host string
}

type restoreCoordinator struct {
	d coordDeps

	// tempos; os testes zeram
	saveDelay      time.Duration // lista com terminais
	emptySaveDelay time.Duration // lista vazia: espera para não gravar um vazio passageiro
	minRewrite     time.Duration // mesma estrutura: no maximo uma gravacao por esse tempo
	// A identidade do host (host.pid) pode demorar a existir depois que o host sobe, e a ponte
	// so' emite outra lista quando algo muda (uma lista vazia continua igual): reavalia sozinho.
	retryDelay time.Duration
	maxRetries int

	mu         sync.Mutex
	lastNote   string // ultima decisao registrada no log (nao repete a cada lista)
	retries    int    // reavaliacoes feitas esperando a identidade do host
	pendFrozen bool   // o reconcile foi congelado so' esperando a identidade do host
	running    bool
	timer      *time.Timer
	pend       pendingSave
	lastKey    string
	lastSave   time.Time
	wg         sync.WaitGroup
	// carry: pasta de trabalho de terminais WSL restaurados que abriram quebrados
	// (id novo -> pasta); a receita a mantem em vez de gravar o "/" que eles informam.
	carry map[int]string
	// holds: terminais que não abriram porque a pasta não existe; a receita os guarda
	// (restore_pending.go) para um host que caia não os perder.
	holds pendingSet
}

// setCarry guarda as pastas a preservar depois de uma restauracao.
func (c *restoreCoordinator) setCarry(m map[int]string) {
	c.mu.Lock()
	c.carry = m
	c.mu.Unlock()
}

func newRestoreCoordinator(d coordDeps) *restoreCoordinator {
	return &restoreCoordinator{d: d, saveDelay: 2 * time.Second, emptySaveDelay: 15 * time.Second, minRewrite: 60 * time.Second,
		retryDelay: time.Second, maxRetries: 30}
}

func countPanes(list []byte) int {
	n := 0
	var ev struct {
		Panes []struct{} `json:"panes"`
	}
	if jsonUnmarshal(list, &ev) == nil {
		n = len(ev.Panes)
	}
	return n
}

// structKey: o que muda a receita de verdade (título muda toda hora com o spinner dos agentes).
func structKey(specs []paneSpec) string {
	var b strings.Builder
	for _, s := range specs {
		tool := ""
		if s.Tool != nil {
			tool = s.Tool.Kind + ":" + s.Tool.ID
		}
		fmt.Fprintf(&b, "%d|%s|%s|%s|%s;", s.PaneID, s.ShellID, s.Distro, s.Cwd, tool)
	}
	return b.String()
}

func (c *restoreCoordinator) onList(list []byte) {
	if !c.d.active() {
		return
	}
	c.mu.Lock()
	if c.running {
		c.mu.Unlock()
		return
	}
	c.mu.Unlock()
	panes := countPanes(list)
	host := c.d.hostID()
	file, have := c.d.loadSpecs()
	restore := have && shouldRestore(file, host, panes, c.d.now())
	c.note(panes, host, file, have, restore)
	if host == "" {
		// Sem a identidade do host nao da' para decidir. Se ha uma receita aproveitavel e o host
		// esta vazio, o reconcile NAO pode rodar (apagaria o layout): congela e reavalia.
		if have && panes == 0 && len(file.Specs) > 0 && recentSpecs(file, c.d.now()) {
			c.mu.Lock()
			first := !c.pendFrozen
			c.pendFrozen = true
			c.mu.Unlock()
			if first {
				c.d.freeze(true)
			}
		}
		c.retryLater(list)
		return
	}
	c.mu.Lock()
	wasPending := c.pendFrozen
	c.retries = 0
	c.mu.Unlock()
	if restore {
		c.mu.Lock()
		if c.running {
			c.mu.Unlock()
			return
		}
		c.running = true
		if c.timer != nil {
			c.timer.Stop()
			c.timer = nil
		}
		c.mu.Unlock()
		c.mu.Lock()
		c.pendFrozen = false // o job de restauracao passa a ser o dono do congelamento
		c.mu.Unlock()
		c.d.freeze(true)
		c.wg.Add(1)
		go func() {
			defer c.wg.Done()
			c.d.start(file)
		}()
		return
	}
	if wasPending { // era so' espera pela identidade: nada a restaurar, libera o reconcile
		c.mu.Lock()
		c.pendFrozen = false
		c.mu.Unlock()
		c.d.freeze(false)
	}
	c.scheduleSave(list, host, panes)
}

// recentSpecs: a receita ainda vale (menos de 7 dias).
func recentSpecs(f specsFile, now time.Time) bool {
	t, err := time.Parse(time.RFC3339, f.SavedAt)
	return err == nil && now.Sub(t) <= specsMaxAge
}

// retryLater reavalia a mesma lista daqui a pouco (a identidade do host ainda nao existe).
// Esgotadas as tentativas, libera o reconcile para o Studio nao ficar congelado.
func (c *restoreCoordinator) retryLater(list []byte) {
	c.mu.Lock()
	c.retries++
	n := c.retries
	pend := c.pendFrozen
	c.mu.Unlock()
	if n > c.maxRetries {
		if pend {
			c.mu.Lock()
			c.pendFrozen = false
			c.mu.Unlock()
			c.d.freeze(false)
		}
		return
	}
	cp := append([]byte(nil), list...)
	c.wg.Add(1)
	time.AfterFunc(c.retryDelay, func() {
		defer c.wg.Done()
		c.onList(cp)
	})
}

// note registra no log a decisao, so' quando algo muda: e' o que explica "por que nao restaurou?".
func (c *restoreCoordinator) note(panes int, host string, f specsFile, have, restore bool) {
	if panes != 0 && !restore {
		return // caso comum (host com terminais): sem barulho
	}
	n := fmt.Sprintf("restore: lista com %d terminais; host atual %q; receita %s (host %q, %d terminais, salva %s); restaurar=%v",
		panes, host, map[bool]string{true: "lida", false: "ausente ou ilegivel"}[have], f.HostID, len(f.Specs), f.SavedAt, restore)
	c.mu.Lock()
	same := n == c.lastNote
	c.lastNote = n
	c.mu.Unlock()
	if !same {
		log.Print(n)
	}
}

func (c *restoreCoordinator) scheduleSave(list []byte, host string, panes int) {
	delay := c.saveDelay
	if panes == 0 {
		delay = c.emptySaveDelay
	}
	c.mu.Lock()
	if c.timer != nil {
		if panes == 0 {
			c.mu.Unlock() // já há uma gravação a caminho; um vazio não a adia nem a substitui
			return
		}
		c.timer.Stop() // chegou lista com terminais: vale mais que um vazio pendente
		c.timer = nil
	}
	c.pend = pendingSave{list: append([]byte(nil), list...), host: host}
	if delay <= 0 {
		c.mu.Unlock()
		c.flush()
		return
	}
	c.timer = time.AfterFunc(delay, c.flush)
	c.mu.Unlock()
}

func (c *restoreCoordinator) flush() {
	c.mu.Lock()
	c.timer = nil
	p := c.pend
	running := c.running
	c.mu.Unlock()
	if running || p.host == "" {
		return
	}
	var specs []paneSpec
	if countPanes(p.list) > 0 {
		specs = append([]paneSpec(nil), c.d.buildSpecs(p.list)...)
		c.mu.Lock()
		applyCarry(specs, c.carry)
		c.mu.Unlock()
	}
	specs = append(specs, c.holds.recipeSpecs(len(specs))...)
	key := p.host + "#" + structKey(specs)
	now := c.d.now()
	c.mu.Lock()
	if key == c.lastKey && now.Sub(c.lastSave) < c.minRewrite {
		c.mu.Unlock()
		return
	}
	c.mu.Unlock()
	f := specsFile{Version: specsVersion, SavedAt: now.Format(time.RFC3339), HostID: p.host, Specs: specs}
	if err := c.d.saveSpecs(f); err != nil {
		return
	}
	c.mu.Lock()
	c.lastKey, c.lastSave = key, now
	c.mu.Unlock()
}

// finished: a restauração terminou (com ou sem falhas); volta a gravar a receita.
func (c *restoreCoordinator) finished() {
	c.mu.Lock()
	c.running = false
	c.lastKey = ""
	c.mu.Unlock()
}

// waitIdle espera as goroutines de restauração (testes).
func (c *restoreCoordinator) waitIdle() { c.wg.Wait() }
