package main

// restore.go — recria os terminais de uma receita (pane_specs.go) num host
// novo. A parte de decisão e ordem fica aqui, sem Win32 nem bridge: o spawner
// e o gate do WSL entram por interfaces e são trocados nos testes.
//
// Terminal WSL cuja pasta não existe (o WSL ainda não montou o disco): se a
// distro tem comando de inicialização configurado, pergunta ao usuário se
// quer rodá-lo, espera terminar e só então abre os terminais dessa distro. O
// que ainda não tiver pasta NÃO abre: vira pendente (restorePending) e a
// receita o guarda, em vez de abrir na home e perder a pasta de trabalho.

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
)

// restoreEnv: o que a restauração precisa do mundo de fora.
type restoreEnv interface {
	// Spawn recria um terminal e devolve o id novo. cwd já foi conferido.
	Spawn(ctx context.Context, s paneSpec, cwd string) (newPane int, err error)
	Progress(p restoreProgress)
	// InitConfig: o init configurado para a distro (nome como no spec).
	InitConfig(distro string) (WSLInitCfg, bool)
	// AskInit pergunta ao usuário se roda o init e bloqueia até a resposta (ou
	// até ctx acabar). run=false é "agora não".
	AskInit(ctx context.Context, distro string, missing []string) (run bool, err error)
	// RunInit roda o init num terminal visível e espera terminar.
	RunInit(ctx context.Context, distro string, cfg WSLInitCfg) initOutcome
}

// wslReady: o gate do WSL (wsl_ready.go implementa).
type wslReady interface {
	Ensure(ctx context.Context, distro string) error
	WaitDir(ctx context.Context, distro, path string) bool
	DirExists(ctx context.Context, distro, path string) bool
	BootID(ctx context.Context, distro string) string
}

// initOutcome: como terminou o terminal de inicialização.
type initOutcome struct {
	Ran          bool
	ExitCode     int
	Err          string
	ClosedByUser bool
	TimedOut     bool
}

// warning: o aviso para o resumo da restauração ("" = nada a avisar).
func (o initOutcome) warning(distro string) string {
	switch {
	case o.TimedOut:
		return fmt.Sprintf("O init do WSL (%s) passou do tempo máximo.", distro)
	case o.Err != "":
		return fmt.Sprintf("O init do WSL (%s) falhou: %s", distro, o.Err)
	}
	return ""
}

type restoreProgress struct {
	Total   int    `json:"total"`
	Done    int    `json:"done"`
	Stage   string `json:"stage"` // start | wsl | ask_init | init | spawn | done
	Distro  string `json:"distro,omitempty"`
	Message string `json:"message,omitempty"`
	// Missing: as pastas que faltam (estágio ask_init).
	Missing []string `json:"missing,omitempty"`
}

type restoreFailure struct {
	PaneID int    `json:"pane_id"`
	Title  string `json:"title,omitempty"`
	Reason string `json:"reason"`
}

// restorePending: terminal WSL que não abriu porque a pasta dele não existe.
type restorePending struct {
	PaneID int      `json:"pane_id"`
	Title  string   `json:"title,omitempty"`
	Distro string   `json:"distro"`
	Cwd    string   `json:"cwd"`
	Keep   bool     `json:"keep,omitempty"` // "Guardar": para de tentar sozinho
	Spec   paneSpec `json:"-"`
	// OldHost: o host que tinha o terminal; é o HostID da folha encerrada dele no layout.
	OldHost string `json:"-"`
	// Name e Look: o nome de aba e a aparência que o terminal tinha (indexados pelo id antigo,
	// que se perde); voltam para o terminal novo quando ele abre.
	Name *PaneName       `json:"-"`
	Look *PaneAppearance `json:"-"`
}

type restoreResult struct {
	Map      map[int]int // id antigo -> id novo
	Failed   []restoreFailure
	Pending  []restorePending
	Warnings []string
}

// wslDirSpec: terminal WSL com pasta de trabalho de verdade (a home não depende de montagem).
func wslDirSpec(s paneSpec) bool {
	return s.Kind == "wsl" && s.Distro != "" && s.Cwd != "" && s.Cwd != "~"
}

func dirKey(distro, path string) string { return strings.ToLower(distro) + "|" + path }

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
	report := func(p restoreProgress, advance bool) {
		mu.Lock()
		if advance {
			done++
		}
		p.Total, p.Done = total, done
		// entrega dentro do lock: fora dele, dois terminais podiam entregar o
		// progresso fora de ordem e a barra andava para trás
		env.Progress(p)
		mu.Unlock()
	}
	fail := func(s paneSpec, reason string) {
		mu.Lock()
		res.Failed = append(res.Failed, restoreFailure{PaneID: s.PaneID, Title: s.Title, Reason: reason})
		mu.Unlock()
		report(restoreProgress{Stage: "spawn"}, true)
	}

	report(restoreProgress{Stage: "start"}, false)

	// 1. cada distro sobe uma vez (as distros conhecidas, na ordem de aparição)
	badDistro := map[string]string{}
	var distros []string
	seen := map[string]bool{}
	for _, s := range ordered {
		if s.Kind != "wsl" || s.Distro == "" || seen[strings.ToLower(s.Distro)] {
			continue
		}
		seen[strings.ToLower(s.Distro)] = true
		distros = append(distros, s.Distro)
	}
	for _, d := range distros {
		if ctx.Err() != nil {
			break
		}
		report(restoreProgress{Stage: "wsl", Distro: d, Message: fmt.Sprintf("Aguardando o WSL (%s)…", d)}, false)
		if err := gate.Ensure(ctx, d); err != nil {
			badDistro[strings.ToLower(d)] = err.Error()
		}
	}

	// 2. as pastas de cada distro (uma conferência por pasta)
	okDir := map[string]bool{} // lido pelo ramo que abre terminais e escrito pelo da pergunta: sempre sob mu
	setOK := func(distro, path string, ok bool) {
		mu.Lock()
		okDir[dirKey(distro, path)] = ok
		mu.Unlock()
	}
	dirsOf := func(distro string) []string {
		var out []string
		have := map[string]bool{}
		for _, s := range ordered {
			if wslDirSpec(s) && strings.EqualFold(s.Distro, distro) && !have[s.Cwd] {
				have[s.Cwd] = true
				out = append(out, s.Cwd)
			}
		}
		return out
	}
	// checkDirs confere as pastas e devolve as que faltam. grace: dá uma folga
	// (até 30 s) à VM fria antes de declarar a pasta ausente.
	checkDirs := func(distro string, grace bool) []string {
		var missing []string
		for _, p := range dirsOf(distro) {
			ok := gate.DirExists(ctx, distro, p)
			setOK(distro, p, ok)
			if !ok {
				missing = append(missing, p)
			}
		}
		if len(missing) == 0 || !grace || ctx.Err() != nil {
			return missing
		}
		gate.WaitDir(ctx, distro, missing[0])
		var still []string
		for _, p := range missing {
			ok := gate.DirExists(ctx, distro, p)
			setOK(distro, p, ok)
			if !ok {
				still = append(still, p)
			}
		}
		return still
	}
	missingOf := map[string][]string{}
	var askNeeded []string
	for _, d := range distros {
		if ctx.Err() != nil {
			break
		}
		if _, bad := badDistro[strings.ToLower(d)]; bad {
			continue
		}
		cfg, configured := env.InitConfig(d)
		asks := configured && cfg.Enabled && strings.TrimSpace(cfg.Command) != ""
		m := checkDirs(d, !asks) // com init configurado a pasta ausente já é o sinal: sem folga
		if len(m) == 0 {
			continue
		}
		missingOf[strings.ToLower(d)] = m
		if asks {
			askNeeded = append(askNeeded, d)
		}
	}

	// 3. os terminais
	spawnAll := func(list []paneSpec) {
		sem := make(chan struct{}, parallel)
		var wg sync.WaitGroup
		for _, s := range list {
			if ctx.Err() != nil {
				break
			}
			if s.Kind == "wsl" && s.Distro != "" {
				if why, bad := badDistro[strings.ToLower(s.Distro)]; bad {
					fail(s, why)
					continue
				}
			}
			if wslDirSpec(s) {
				mu.Lock()
				ok := okDir[dirKey(s.Distro, s.Cwd)]
				if !ok {
					res.Pending = append(res.Pending, restorePending{PaneID: s.PaneID, Title: s.Title, Distro: s.Distro, Cwd: s.Cwd, Spec: s})
				}
				mu.Unlock()
				if !ok {
					continue
				}
			}
			sem <- struct{}{}
			wg.Add(1)
			go func(s paneSpec) {
				defer func() { <-sem; wg.Done() }()
				newPane, err := env.Spawn(ctx, s, s.Cwd)
				if err != nil {
					fail(s, err.Error())
					return
				}
				mu.Lock()
				res.Map[s.PaneID] = newPane
				mu.Unlock()
				report(restoreProgress{Stage: "spawn"}, true)
			}(s)
		}
		wg.Wait()
	}

	if len(askNeeded) == 0 {
		spawnAll(ordered) // caminho comum: tudo em ordem, como sempre
	} else {
		blocked := map[string]bool{}
		for _, d := range askNeeded {
			blocked[strings.ToLower(d)] = true
		}
		var early, late []paneSpec
		for _, s := range ordered {
			if s.Kind == "wsl" && blocked[strings.ToLower(s.Distro)] {
				late = append(late, s)
			} else {
				early = append(early, s)
			}
		}
		// o que não depende da pergunta abre já, sem esperar a resposta
		var wg sync.WaitGroup
		wg.Add(1)
		go func() { defer wg.Done(); spawnAll(early) }()
		for _, d := range askNeeded {
			if ctx.Err() != nil {
				break
			}
			report(restoreProgress{Stage: "ask_init", Distro: d, Missing: missingOf[strings.ToLower(d)]}, false)
			run, err := env.AskInit(ctx, d, missingOf[strings.ToLower(d)])
			if err != nil || !run {
				continue
			}
			cfg, _ := env.InitConfig(d)
			report(restoreProgress{Stage: "init", Distro: d, Message: fmt.Sprintf("Executando o init do WSL (%s)…", d)}, false)
			out := env.RunInit(ctx, d, cfg)
			if w := out.warning(d); w != "" {
				mu.Lock()
				res.Warnings = append(res.Warnings, w)
				mu.Unlock()
			}
			checkDirs(d, true) // o init costuma montar o disco: reconfere com folga
		}
		spawnAll(late)
		wg.Wait()
	}
	if ctx.Err() != nil {
		// o tempo do job acabou (ninguém respondeu a pergunta, o init demorou demais) ou o
		// Studio vai sair: o que não abriu não pode sumir da receita; fica pendente
		mu.Lock()
		handled := map[int]bool{}
		for id := range res.Map {
			handled[id] = true
		}
		for _, f := range res.Failed {
			handled[f.PaneID] = true
		}
		for _, p := range res.Pending {
			handled[p.PaneID] = true
		}
		for _, s := range ordered {
			if !handled[s.PaneID] {
				res.Pending = append(res.Pending, restorePending{PaneID: s.PaneID, Title: s.Title, Distro: s.Distro, Cwd: s.Cwd, Spec: s})
			}
		}
		mu.Unlock()
	} else {
		report(restoreProgress{Stage: "done"}, false)
	}
	return res
}
