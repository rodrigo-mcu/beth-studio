package main

import (
	"sync"
	"time"
)

// restartLimiter permite no máximo `max` reinícios do host numa janela
// deslizante. Tentativas negadas não contam, para o limite não se estender
// sozinho enquanto a interface mostra "Host indisponível".
type restartLimiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	hits   []time.Time
}

func newRestartLimiter(max int, window time.Duration) *restartLimiter {
	return &restartLimiter{max: max, window: window}
}

func (l *restartLimiter) prune(now time.Time) {
	keep := l.hits[:0]
	for _, h := range l.hits {
		if now.Sub(h) < l.window {
			keep = append(keep, h)
		}
	}
	l.hits = keep
}

// Allow registra o reinício e devolve true se ainda cabe na janela.
func (l *restartLimiter) Allow(now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.prune(now)
	if len(l.hits) >= l.max {
		return false
	}
	l.hits = append(l.hits, now)
	return true
}

// Reset esquece os reinícios (o usuário pediu para tentar de novo).
func (l *restartLimiter) Reset() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.hits = nil
}

// RetryAt: quando volta a caber um reinício (zero se já cabe).
func (l *restartLimiter) RetryAt(now time.Time) time.Time {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.prune(now)
	if len(l.hits) < l.max {
		return time.Time{}
	}
	return l.hits[0].Add(l.window)
}
