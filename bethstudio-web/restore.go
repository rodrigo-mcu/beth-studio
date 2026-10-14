package main

// restore.go — recria os terminais de uma receita (pane_specs.go) num host
// novo. A parte de decisão e ordem fica aqui, sem Win32 nem bridge: o spawner
// e o gate do WSL entram por interfaces e são trocados nos testes.

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
)

// restoreEnv: o que a restauração precisa do mundo de fora.
type restoreEnv interface {
	// Spawn recria um terminal e devolve o id novo. cwd já passou pelo gate.
	Spawn(ctx context.Context, s paneSpec, cwd string) (newPane int, err error)
	Progress(p restoreProgress)
}

// wslReady: o gate do WSL (wsl_ready.go implementa).
type wslReady interface {
	Ensure(ctx context.Context, distro string) (initErr error, err error)
	WaitDir(ctx context.Context, distro, path string) bool
}

type restoreProgress struct {
	Total   int    `json:"total"`
	Done    int    `json:"done"`
	Stage   string `json:"stage"` // start | wsl | spawn | done
	Distro  string `json:"distro,omitempty"`
	Message string `json:"message,omitempty"`
}

type restoreFailure struct {
	PaneID int    `json:"pane_id"`
	Title  string `json:"title,omitempty"`
	Reason string `json:"reason"`
}

type restoreFallback struct {
	PaneID int    `json:"pane_id"`
	Cwd    string `json:"cwd"`
}

type restoreResult struct {
	Map       map[int]int // id antigo -> id novo
	Failed    []restoreFailure
	Fallbacks []restoreFallback // pasta que não apareceu: abriu na home
	Warnings  []string
}

// runRestore recria os terminais na ordem de `Order`, até `parallel` ao mesmo
// tempo. A falha de um terminal (ou de uma distro) não interrompe os outros.
func runRestore(ctx context.Context, specs []paneSpec, env restoreEnv, gate wslReady, parallel int) restoreResult {
	if parallel < 1 {
		parallel = 1
	}
	res := restoreResult{Map: map[int]int{}}
	ordered := append([]paneSpec(nil), specs...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Order < ordered[j].Order })
	total := len(ordered)

	var mu sync.Mutex
	done := 0
	report := func(stage, distro, msg string, advance bool) {
		mu.Lock()
		if advance {
			done++
		}
		p := restoreProgress{Total: total, Done: done, Stage: stage, Distro: distro, Message: msg}
		// entrega dentro do lock: fora dele, dois terminais podiam entregar o
		// progresso fora de ordem e a barra andava para trás
		env.Progress(p)
		mu.Unlock()
	}
	fail := func(s paneSpec, reason string) {
		mu.Lock()
		res.Failed = append(res.Failed, restoreFailure{PaneID: s.PaneID, Title: s.Title, Reason: reason})
		mu.Unlock()
		report("spawn", "", "", true)
	}

	report("start", "", "", false)

	// 1. o gate, uma vez por distro (as distros conhecidas, na ordem de aparição)
	badDistro := map[string]string{}
	seen := map[string]bool{}
	for _, s := range ordered {
		if s.Kind != "wsl" || s.Distro == "" || seen[strings.ToLower(s.Distro)] {
			continue
		}
		seen[strings.ToLower(s.Distro)] = true
		if ctx.Err() != nil {
			break
		}
		report("wsl", s.Distro, fmt.Sprintf("Aguardando o WSL (%s)…", s.Distro), false)
		initErr, err := gate.Ensure(ctx, s.Distro)
		if err != nil {
			badDistro[strings.ToLower(s.Distro)] = err.Error()
			continue
		}
		if initErr != nil {
			res.Warnings = append(res.Warnings, initErr.Error())
		}
	}

	// 2. os terminais
	sem := make(chan struct{}, parallel)
	var wg sync.WaitGroup
	for _, s := range ordered {
		if ctx.Err() != nil {
			break
		}
		if s.Kind == "wsl" && s.Distro != "" {
			if why, bad := badDistro[strings.ToLower(s.Distro)]; bad {
				fail(s, why)
				continue
			}
		}
		sem <- struct{}{}
		wg.Add(1)
		go func(s paneSpec) {
			defer func() { <-sem; wg.Done() }()
			cwd := s.Cwd
			if s.Kind == "wsl" && s.Distro != "" && cwd != "" && cwd != "~" {
				if !gate.WaitDir(ctx, s.Distro, cwd) {
					mu.Lock()
					res.Fallbacks = append(res.Fallbacks, restoreFallback{PaneID: s.PaneID, Cwd: cwd})
					mu.Unlock()
					cwd = "" // a pasta não apareceu: abre na home, nunca em "/"
				}
			}
			newPane, err := env.Spawn(ctx, s, cwd)
			if err != nil {
				fail(s, err.Error())
				return
			}
			mu.Lock()
			res.Map[s.PaneID] = newPane
			mu.Unlock()
			report("spawn", "", "", true)
		}(s)
	}
	wg.Wait()
	if ctx.Err() == nil {
		report("done", "", "", false)
	}
	return res
}
