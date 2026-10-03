package main

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

// Limite de tentativas de senha pelo túnel (celular e Studio remoto).
//
// Por IP: 5 erros seguidos travam esse IP por 1 minuto; cada nova trava
// dobra (até 15 min) e o contador volta a zero depois de 1 h sem erro.
// Geral: 30 erros em 10 minutos, somando todos os IPs, travam o login pelo
// túnel até a janela passar. O Studio no PC não passa por aqui.
const (
	limitPerIP      = 5
	limitFirstLock  = time.Minute
	limitMaxLock    = 15 * time.Minute
	limitForget     = time.Hour
	limitGlobalMax  = 30
	limitGlobalSpan = 10 * time.Minute
)

type limitEntry struct {
	n       int
	strikes int
	until   time.Time
	last    time.Time
}

type loginLimiter struct {
	mu     sync.Mutex
	per    map[string]*limitEntry
	global []time.Time
	now    func() time.Time
}

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{per: map[string]*limitEntry{}}
}

func (l *loginLimiter) clock() time.Time {
	if l.now != nil {
		return l.now()
	}
	return time.Now()
}

func waitMsg(d time.Duration) error {
	m := int((d + time.Minute - 1) / time.Minute)
	if m <= 1 {
		return errors.New("muitas tentativas, espere um minuto")
	}
	return fmt.Errorf("muitas tentativas, espere %d minutos", m)
}

func (l *loginLimiter) pruneLocked(now time.Time) {
	cut := now.Add(-limitGlobalSpan)
	i := 0
	for i < len(l.global) && !l.global[i].After(cut) {
		i++
	}
	l.global = l.global[i:]
	if l.per == nil {
		l.per = map[string]*limitEntry{}
	}
	for ip, e := range l.per {
		if now.Sub(e.last) > limitForget && !now.Before(e.until) {
			delete(l.per, ip)
		}
	}
}

// check diz se este IP pode tentar agora.
func (l *loginLimiter) check(ip string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.clock()
	l.pruneLocked(now)
	if e := l.per[ip]; e != nil && now.Before(e.until) {
		return waitMsg(e.until.Sub(now))
	}
	if len(l.global) >= limitGlobalMax {
		return waitMsg(l.global[0].Add(limitGlobalSpan).Sub(now))
	}
	return nil
}

// fail registra um erro; devolve true quando este erro travou o IP.
func (l *loginLimiter) fail(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.clock()
	l.pruneLocked(now)
	l.global = append(l.global, now)
	e := l.per[ip]
	if e == nil {
		e = &limitEntry{}
		l.per[ip] = e
	}
	e.last = now
	e.n++
	if e.n < limitPerIP {
		return false
	}
	e.n = 0
	lock := limitFirstLock << e.strikes
	if lock > limitMaxLock || lock <= 0 {
		lock = limitMaxLock
	}
	if e.strikes < 8 {
		e.strikes++
	}
	e.until = now.Add(lock)
	return true
}

// ok: login certo, este IP começa do zero.
func (l *loginLimiter) ok(ip string) {
	l.mu.Lock()
	delete(l.per, ip)
	l.mu.Unlock()
}

// Um limitador só para o celular e o Studio remoto: errar num conta no outro.
var tunnelLogins = newLoginLimiter()
