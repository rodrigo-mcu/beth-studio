package main

// term_registry.go — janelas de terminal destacadas (processos
// `bethterm-web.exe --term <pane>`). O registro só guarda quem é quem; fechar
// uma janela mata o processo DA JANELA, nunca o terminal no host.

import (
	"sort"
	"sync"
)

type termProc interface {
	Focus()
	Kill()
}

type termRegistry struct {
	mu       sync.Mutex
	m        map[int]termProc
	onChange func(panes []int)
}

func newTermRegistry(onChange func(panes []int)) *termRegistry {
	return &termRegistry{m: map[int]termProc{}, onChange: onChange}
}

func (r *termRegistry) panesLocked() []int {
	out := make([]int, 0, len(r.m))
	for p := range r.m {
		out = append(out, p)
	}
	sort.Ints(out)
	return out
}

func (r *termRegistry) notify(panes []int) {
	if r.onChange != nil {
		r.onChange(panes)
	}
}

// Add registra a janela. Se o pane já tem janela, foca a existente e devolve true.
func (r *termRegistry) Add(pane int, p termProc) (existed bool) {
	r.mu.Lock()
	if old, ok := r.m[pane]; ok {
		r.mu.Unlock()
		old.Focus()
		return true
	}
	r.m[pane] = p
	panes := r.panesLocked()
	r.mu.Unlock()
	r.notify(panes)
	return false
}

func (r *termRegistry) Remove(pane int) bool {
	r.mu.Lock()
	if _, ok := r.m[pane]; !ok {
		r.mu.Unlock()
		return false
	}
	delete(r.m, pane)
	panes := r.panesLocked()
	r.mu.Unlock()
	r.notify(panes)
	return true
}

func (r *termRegistry) Has(pane int) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.m[pane]
	return ok
}

func (r *termRegistry) get(pane int) termProc {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.m[pane]
}

func (r *termRegistry) Focus(pane int) bool {
	p := r.get(pane)
	if p == nil {
		return false
	}
	p.Focus()
	return true
}

// Close encerra o processo da janela (o registro é limpo quando ele sai).
func (r *termRegistry) Close(pane int) bool {
	p := r.get(pane)
	if p == nil {
		return false
	}
	p.Kill()
	return true
}

func (r *termRegistry) Panes() []int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.panesLocked()
}

func (r *termRegistry) CloseAll() {
	r.mu.Lock()
	procs := make([]termProc, 0, len(r.m))
	for _, p := range r.m {
		procs = append(procs, p)
	}
	r.mu.Unlock()
	for _, p := range procs {
		p.Kill()
	}
}
