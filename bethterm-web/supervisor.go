package main

// supervisor.go — o Studio vigia o bethterm-host.exe: sobe se não existe,
// reinicia se cair (no máximo 3 vezes em 10 minutos) e nunca o encerra por
// conta própria. Quem encerra é o usuário, em "Encerrar tudo".

import (
	"context"
	"fmt"
	"sync"
	"time"
)

type hostState string

const (
	hostRunning     hostState = "running"
	hostStarting    hostState = "starting"
	hostUnavailable hostState = "unavailable"
	hostQuitting    hostState = "quitting"
	hostGUIManaged  hostState = "gui-managed"
)

const supervisorInterval = 2 * time.Second

type supervisor struct {
	ctl     hostCtl
	lim     *restartLimiter
	now     func() time.Time
	onState func(hostState, string)

	mu        sync.Mutex
	state     hostState
	msg       string
	quitAsked bool
}

func newSupervisor(ctl hostCtl, lim *restartLimiter, now func() time.Time, onState func(hostState, string)) *supervisor {
	return &supervisor{ctl: ctl, lim: lim, now: now, onState: onState}
}

func (s *supervisor) set(st hostState, msg string) {
	s.mu.Lock()
	changed := st != s.state || msg != s.msg
	s.state, s.msg = st, msg
	cb := s.onState
	s.mu.Unlock()
	if changed && cb != nil {
		cb(st, msg)
	}
}

// State: estado atual e a mensagem para a interface.
func (s *supervisor) State() (hostState, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state, s.msg
}

// AskQuit marca que o usuário pediu "Encerrar tudo": o host não volta mais.
func (s *supervisor) AskQuit() {
	s.mu.Lock()
	s.quitAsked = true
	s.mu.Unlock()
}

// Retry: o usuário pediu "Tentar de novo" depois de "Host indisponível".
func (s *supervisor) Retry() {
	s.lim.Reset()
	s.Tick()
}

// Tick faz uma avaliação.
func (s *supervisor) Tick() {
	s.mu.Lock()
	quit := s.quitAsked
	s.mu.Unlock()

	// A GUI antiga ainda supervisiona: não ter dois supervisores.
	if s.ctl.GUIRunning() {
		s.set(hostGUIManaged, "A janela nativa antiga está cuidando do host.")
		return
	}
	if quit {
		if s.ctl.Running() {
			s.set(hostQuitting, "Encerrando o BethTerm…")
		} else {
			s.set(hostQuitting, "Encerrado a pedido do usuário.")
		}
		return
	}

	now := s.now()
	if s.ctl.Running() {
		s.set(hostRunning, "")
		return
	}

	// a janela deslizante do limitador já esquece quedas antigas
	if !s.lim.Allow(now) {
		at := s.lim.RetryAt(now)
		s.set(hostUnavailable, fmt.Sprintf("O host caiu 3 vezes em 10 minutos. Nova tentativa automática às %s, ou use Tentar de novo.", at.Format("15:04")))
		return
	}
	s.set(hostStarting, "Iniciando o host…")
	lifeLog("host ausente; iniciando")
	if err := s.ctl.Start(); err != nil {
		lifeLog("falha ao iniciar o host: " + err.Error())
		s.set(hostStarting, "Não foi possível iniciar o host: "+err.Error())
		return
	}
	lifeLog("host iniciado")
	s.set(hostRunning, "")
}

// Run avalia a cada 2 s até ctx terminar.
func (s *supervisor) Run(ctx context.Context) {
	s.Tick()
	t := time.NewTicker(supervisorInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.Tick()
		}
	}
}
