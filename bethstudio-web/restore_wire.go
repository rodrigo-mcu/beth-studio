package main

// restore_wire.go — liga a restauração ao hub, à bridge e às configurações:
// espera pelo evento `spawned`, emite o progresso para a interface e, no fim,
// remapeia o layout. A decisão fica em restore_coord.go e restore.go.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

var spawnErrReqRe = regexp.MustCompile(`\(request ([A-Za-z0-9_-]+)\)`)

type spawnResult struct {
	PaneID int
	Err    string
}

// awaitSpawn registra uma espera pelo resultado do spawn com esse request_id.
func (h *hub) awaitSpawn(reqID string) chan spawnResult {
	ch := make(chan spawnResult, 1)
	h.mu.Lock()
	if h.spawnWait == nil {
		h.spawnWait = map[string]chan spawnResult{}
	}
	h.spawnWait[reqID] = ch
	h.mu.Unlock()
	return ch
}

func (h *hub) dropSpawnWait(reqID string) {
	h.mu.Lock()
	delete(h.spawnWait, reqID)
	h.mu.Unlock()
}

// notifySpawn entrega o resultado a quem espera; false se ninguém espera.
func (h *hub) notifySpawn(reqID string, r spawnResult) bool {
	h.mu.Lock()
	ch := h.spawnWait[reqID]
	delete(h.spawnWait, reqID)
	h.mu.Unlock()
	if ch == nil {
		return false
	}
	select {
	case ch <- r:
	default:
	}
	return true
}

// spawnErrRequestID: o request_id de "spawn <shell> (request r1): erro".
func spawnErrRequestID(msg string) string {
	if m := spawnErrReqRe.FindStringSubmatch(msg); m != nil {
		return m[1]
	}
	return ""
}

// setRestore guarda e transmite o estado da restauração para a interface.
func (h *hub) setRestore(ev map[string]any) {
	ev["ev"] = "restore"
	b, err := json.Marshal(ev)
	if err != nil {
		return
	}
	h.mu.Lock()
	h.restoreMsg = b
	cs := h.clientsLocked()
	h.mu.Unlock()
	for _, c := range cs {
		c.enqueue(b)
	}
}

// hubRestoreEnv: o restoreEnv de verdade (spawn pela bridge).
type hubRestoreEnv struct {
	h   *hub
	seq atomic.Int64

	lastMu sync.Mutex
	last   restoreProgress // o último progresso, para o relógio do init repetir total e feitos
}

func (e *hubRestoreEnv) lastProgress() restoreProgress {
	e.lastMu.Lock()
	defer e.lastMu.Unlock()
	return e.last
}

func (e *hubRestoreEnv) Progress(p restoreProgress) {
	e.lastMu.Lock()
	e.last = p
	e.lastMu.Unlock()
	e.h.setRestore(map[string]any{
		"stage": p.Stage, "total": p.Total, "done": p.Done, "distro": p.Distro, "message": p.Message, "missing": p.Missing,
	})
}

// InitConfig: o init que o usuário configurou para a distro (Configurações > Terminais > WSL).
func (e *hubRestoreEnv) InitConfig(distro string) (WSLInitCfg, bool) {
	return settings.wslInitFor(distro)
}

func (e *hubRestoreEnv) Spawn(ctx context.Context, s paneSpec, cwd string) (int, error) {
	if e.h.bridge == nil {
		return 0, errBridgeDown
	}
	reqID := fmt.Sprintf("rs%d", e.seq.Add(1))
	var msg map[string]any
	var shell string
	if s.Tool != nil {
		m, sh, err := toolSpawnMessage(s.Tool.Kind, s.Tool.ID, reqID, nil)
		if err != nil {
			return 0, err
		}
		msg, shell = m, sh
	} else {
		if !shellIDRe.MatchString(s.ShellID) {
			return 0, fmt.Errorf("shell_id inválido: %q", s.ShellID)
		}
		msg = map[string]any{"op": "spawn", "shell_id": s.ShellID, "request_id": reqID}
		shell = s.ShellID
		if cwd != "" {
			msg["cwd"] = cwd
		}
		if s.Kind == "wsl" && distroRe.MatchString(s.Distro) {
			msg["distro"] = s.Distro
		}
	}
	ch := e.h.awaitSpawn(reqID)
	defer e.h.dropSpawnWait(reqID)
	e.h.noteSpawn(reqID, shell)
	if err := e.h.bridge.write(msg); err != nil {
		return 0, err
	}
	select {
	case r := <-ch:
		if r.Err != "" {
			return 0, fmt.Errorf("%s", r.Err)
		}
		return r.PaneID, nil
	case <-time.After(30 * time.Second):
		return 0, fmt.Errorf("o host não respondeu ao pedido de abrir o terminal em 30 s")
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

var distroRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// newHubRestore monta o coordenador de verdade para este hub.
func newHubRestore(h *hub) *restoreCoordinator {
	var c *restoreCoordinator
	d := coordDeps{
		hostID:    settings.hostID,
		now:       time.Now,
		loadSpecs: func() (specsFile, bool) { return loadSpecs(specsPath()) },
		saveSpecs: func(f specsFile) error { return saveSpecs(specsPath(), f) },
		buildSpecs: func(list []byte) []paneSpec {
			return buildSpecs(list, settings.spawnedMap(), settings.snapshot().Layout)
		},
		freeze: settings.setFrozen,
		active: func() bool {
			if h.sup == nil {
				return false
			}
			st, _ := h.sup.State()
			return st != "" && st != hostGUIManaged
		},
		start: func(file specsFile) { h.runRestoreJob(file, c) },
	}
	c = newRestoreCoordinator(d)
	h.pendingRetry.kick = h.startPendingRetry // "Continuar tentando" recomeça a retentativa automática
	return c
}

// runRestoreJob recria os terminais, espera os ids novos aparecerem na lista
// e remapeia o layout. Sempre descongela o reconcile ao terminar.
func (h *hub) runRestoreJob(file specsFile, c *restoreCoordinator) {
	defer c.finished()
	defer settings.setFrozen(false)
	// uma hora: a pergunta do init espera o usuário (que pode estar longe do PC) e o init tem até 30 min
	ctx, cancel := context.WithTimeout(context.Background(), time.Hour)
	defer cancel()
	log.Printf("restore: recriando %d terminais depois da queda do host", len(file.Specs))
	lifeLog(fmt.Sprintf("host novo e vazio; recriando %d terminais da receita", len(file.Specs)))
	// copia ANTES de recriar: recordSpawn apaga a aparencia do terminal antigo cujo id coincide com o novo
	base := settings.captureRemapBase()
	res := runRestore(ctx, file.Specs, &hubRestoreEnv{h: h}, h.wslGate, 3)
	// o que o terminal pendente perde com o id antigo (nome de aba, aparência) fica guardado até ele abrir
	for i := range res.Pending {
		p := &res.Pending[i]
		p.OldHost = file.HostID
		if n := base.names[strconv.Itoa(p.PaneID)]; n != nil {
			c := *n
			p.Name = &c
		}
		if a := base.panes[strconv.Itoa(p.PaneID)]; a != nil {
			c := *a
			p.Look = &c
		}
		p.useOrigin() // segundo reinício: volta a ser o terminal original (id, host, nome, aparência)
	}
	c.holds.set(res.Pending)
	// um terminal WSL que abrir quebrado informa "/": a receita guarda a pasta de antes
	c.setCarry(carryCwds(file.Specs, res.Map))

	// o reconcile só pode voltar quando a lista já mostra os terminais novos
	ids := make([]int, 0, len(res.Map))
	for _, nid := range res.Map {
		ids = append(ids, nid)
	}
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) && !settings.liveHas(ids) {
		time.Sleep(200 * time.Millisecond)
	}
	settings.remapPanesFrom(base, res.Map, settings.hostID())
	settings.parkPending(res.Pending) // a folha do pendente vai para um grupo fechado, onde o reconcile não a apaga

	lifeLog(fmt.Sprintf("restauração terminou: %d recriados, %d falharam, %d aguardando a pasta", len(res.Map), len(res.Failed), len(res.Pending)))
	h.setRestore(map[string]any{
		"stage": "finished", "total": len(file.Specs), "done": len(res.Map),
		"failed": res.Failed, "pending": res.Pending, "warnings": res.Warnings,
	})
	if len(res.Pending) > 0 {
		h.startPendingRetry()
	}
}

// pendingDeps: o que as ações sobre terminais pendentes usam, ligado ao hub e ao Studio de verdade.
func (h *hub) pendingDeps() pendingDeps {
	env := &hubRestoreEnv{h: h}
	return pendingDeps{
		dirExists: func(ctx context.Context, distro, path string) bool {
			return h.wslGate != nil && h.wslGate.DirExists(ctx, distro, path)
		},
		open: env.Spawn,
		revive: func(p restorePending, newPane int) {
			host := settings.hostID()
			settings.reviveLeaf(p.PaneID, newPane, p.OldHost, host)
			settings.adoptIdentity(newPane, p.Name, p.Look, host)
			lifeLog(fmt.Sprintf("terminal pendente #%d aberto como #%d (%s)", p.PaneID, newPane, p.Cwd))
		},
		discard: func(p restorePending) {
			settings.removeGoneLeaf(p.PaneID, p.OldHost)
			lifeLog(fmt.Sprintf("terminal pendente #%d descartado (%s)", p.PaneID, p.Cwd))
		},
		defaultDir: func(distro string) string {
			c, _ := settings.wslInitFor(distro)
			return c.DefaultDir
		},
		publish: h.publishPending,
	}
}

// publishPending reenvia o último evento `restore` com a lista de pendentes nova.
func (h *hub) publishPending(list []restorePending) {
	h.mu.Lock()
	raw := h.restoreMsg
	h.mu.Unlock()
	ev := map[string]any{"stage": "finished"}
	if raw != nil {
		_ = json.Unmarshal(raw, &ev)
	}
	if list == nil {
		list = []restorePending{}
	}
	ev["pending"] = list
	h.setRestore(ev)
}

// startPendingRetry reconfere os pendentes a cada 15 s por 5 min (renovado a cada chamada).
func (h *hub) startPendingRetry() {
	st := &h.pendingRetry
	st.until.Store(time.Now().Add(pendingRetryWindow).UnixNano())
	if !st.running.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer st.running.Store(false)
		for {
			time.Sleep(pendingRetryEvery)
			if h.restore == nil || time.Now().UnixNano() > st.until.Load() {
				return
			}
			active := false
			for _, p := range h.restore.holds.list() {
				if !p.Keep {
					active = true
				}
			}
			if !active {
				return
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			h.restore.holds.retryAll(ctx, h.pendingDeps())
			cancel()
		}
	}()
}
