package vpsinstall

import (
	"sort"
	"strings"
	"sync"
)

// Redactor troca segredos conhecidos por *** em qualquer texto que vá à tela
// ou ao log. É a última barreira: os segredos também não são colocados nas
// mensagens, mas a saída de comandos remotos pode ecoá-los.
type Redactor struct {
	mu   sync.Mutex
	list []string
}

func NewRedactor(secrets ...string) *Redactor {
	r := &Redactor{}
	for _, s := range secrets {
		r.Add(s)
	}
	return r
}

func (r *Redactor) Add(s string) {
	s = strings.TrimSpace(s)
	if len(s) < 3 {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, x := range r.list {
		if x == s {
			return
		}
	}
	r.list = append(r.list, s)
	// os maiores primeiro, para um segredo contido em outro não deixar sobra
	sort.Slice(r.list, func(i, j int) bool { return len(r.list[i]) > len(r.list[j]) })
}

func (r *Redactor) Clean(s string) string {
	if r == nil {
		return s
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, x := range r.list {
		s = strings.ReplaceAll(s, x, "***")
	}
	return s
}
