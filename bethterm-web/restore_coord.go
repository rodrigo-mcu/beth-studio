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
	minRewrite     time.Duration // mesma estrutura: no máximo uma gravação por esse tempo

	mu       sync.Mutex
	running  bool
	timer    *time.Timer
	pend     pendingSave
	lastKey  string
	lastSave time.Time
	wg       sync.WaitGroup
}

func newRestoreCoordinator(d coordDeps) *restoreCoordinator {
	return &restoreCoordinator{d: d, saveDelay: 2 * time.Second, emptySaveDelay: 15 * time.Second, minRewrite: 60 * time.Second}
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
	if have && shouldRestore(file, host, panes, c.d.now()) {
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
		c.d.freeze(true)
		c.wg.Add(1)
		go func() {
			defer c.wg.Done()
			c.d.start(file)
		}()
		return
	}
	if host == "" {
		return // sem a identidade do host não dá para gravar nem decidir
	}
	c.scheduleSave(list, host, panes)
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
		specs = c.d.buildSpecs(p.list)
	}
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
