package vpsinstall

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
	"time"
)

// Job é uma execução do assistente (instalar, atualizar, remover…) em segundo
// plano, com eventos que a tela lê por polling.
type Job struct {
	ID   string
	Kind string

	mu      sync.Mutex
	events  []Event
	done    bool
	errMsg  string
	errHint string
	outcome *Outcome
	text    string
	cancel  context.CancelFunc
}

type JobView struct {
	ID      string   `json:"id"`
	Kind    string   `json:"kind"`
	Events  []Event  `json:"events"`
	Next    int      `json:"next"`
	Done    bool     `json:"done"`
	OK      bool     `json:"ok"`
	Error   string   `json:"error,omitempty"`
	Hint    string   `json:"hint,omitempty"`
	Outcome *Outcome `json:"outcome,omitempty"`
	Text    string   `json:"text,omitempty"`
}

// View devolve os eventos a partir do índice since.
func (j *Job) View(since int) JobView {
	j.mu.Lock()
	defer j.mu.Unlock()
	if since < 0 || since > len(j.events) {
		since = 0
	}
	v := JobView{ID: j.ID, Kind: j.Kind, Events: append([]Event(nil), j.events[since:]...), Next: len(j.events),
		Done: j.done, OK: j.done && j.errMsg == "", Error: j.errMsg, Hint: j.errHint}
	if j.done {
		v.Outcome, v.Text = j.outcome, j.text
	}
	return v
}

func (j *Job) Running() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return !j.done
}

// Manager mantém um job por vez.
type Manager struct {
	mu  sync.Mutex
	cur *Job
}

var ErrBusy = errors.New("já existe uma operação do servidor em andamento")

// Start roda fn em segundo plano. fn devolve o resultado, um texto opcional (estado/logs) e o erro.
func (m *Manager) Start(kind string, fn func(ctx context.Context, emit Emit) (*Outcome, string, error)) (*Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cur != nil && m.cur.Running() {
		return nil, ErrBusy
	}
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
	j := &Job{ID: hex.EncodeToString(b), Kind: kind, cancel: cancel}
	m.cur = j
	go func() {
		defer cancel()
		out, text, err := fn(ctx, func(e Event) {
			j.mu.Lock()
			j.events = append(j.events, e)
			j.mu.Unlock()
		})
		j.mu.Lock()
		defer j.mu.Unlock()
		j.done = true
		j.outcome, j.text = out, text
		if err != nil {
			j.errMsg = err.Error()
			var se *StepError
			if errors.As(err, &se) {
				j.errHint = se.Hint
			}
		}
	}()
	return j, nil
}

// Get devolve o job atual se o id bater.
func (m *Manager) Get(id string) *Job {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cur != nil && m.cur.ID == id {
		return m.cur
	}
	return nil
}

// Cancel interrompe o job em andamento.
func (m *Manager) Cancel() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cur != nil && m.cur.cancel != nil {
		m.cur.cancel()
	}
}
