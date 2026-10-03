package main

// Consultas salvas do editor (db-queries.json). O histórico recente continua
// no navegador; o que o usuário manda "Salvar" fica neste arquivo.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	dbQueriesFile = "db-queries.json"
	dbQueriesMax  = 4000
	dbQuerySQLMax = 512 << 10
)

type dbSavedQuery struct {
	ID     string `json:"id"`
	ConnID string `json:"connId"` // "" = vale para todas as conexões
	Name   string `json:"name"`
	SQL    string `json:"sql"`
	At     string `json:"at"`
}

type dbQueryFile struct {
	Version int            `json:"version"`
	Saved   []dbSavedQuery `json:"saved"`
}

type dbQueryStore struct {
	mu    sync.Mutex
	dir   string
	saved []dbSavedQuery
	ok    bool
}

var dbQueries = &dbQueryStore{}

func (st *dbQueryStore) path() string {
	if st.dir == "" {
		st.dir = dataDir()
	}
	return filepath.Join(st.dir, dbQueriesFile)
}

func (st *dbQueryStore) load() error {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.loadLocked()
}

func (st *dbQueryStore) loadLocked() error {
	if st.ok {
		return nil
	}
	st.saved = nil
	b, err := os.ReadFile(st.path())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			st.ok = true
			return nil
		}
		return err
	}
	var f dbQueryFile
	if err := json.Unmarshal(b, &f); err != nil {
		return err
	}
	st.saved = f.Saved
	st.ok = true
	return nil
}

func (st *dbQueryStore) saveLocked() error {
	f := dbQueryFile{Version: 1, Saved: st.saved}
	if f.Saved == nil {
		f.Saved = []dbSavedQuery{}
	}
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(st.path(), b)
}

func (st *dbQueryStore) list() ([]dbSavedQuery, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if err := st.loadLocked(); err != nil {
		return nil, err
	}
	out := append([]dbSavedQuery(nil), st.saved...)
	return out, nil
}

func (st *dbQueryStore) save(connID, name, sql string) ([]dbSavedQuery, error) {
	name = strings.TrimSpace(name)
	sql = strings.TrimSpace(sql)
	// connID vazio = consulta de todas as conexões (serve em qualquer banco)
	if connID != "" && !dbIDRe.MatchString(connID) {
		return nil, errors.New("conexão inválida")
	}
	if name == "" || utf8.RuneCountInString(name) > 200 {
		return nil, errors.New("dê um nome à consulta (até 200 caracteres)")
	}
	if sql == "" || len(sql) > dbQuerySQLMax {
		return nil, errors.New("consulta vazia ou grande demais")
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	if err := st.loadLocked(); err != nil {
		return nil, err
	}
	next := []dbSavedQuery{{
		ID: dbNewID(), ConnID: connID, Name: name, SQL: sql, At: time.Now().UTC().Format(time.RFC3339),
	}}
	for _, q := range st.saved {
		if q.ConnID == connID && q.Name == name {
			continue
		}
		next = append(next, q)
		if len(next) >= dbQueriesMax {
			break
		}
	}
	prev := st.saved
	st.saved = next
	if err := st.saveLocked(); err != nil {
		st.saved = prev
		return nil, err
	}
	return append([]dbSavedQuery(nil), st.saved...), nil
}

func (st *dbQueryStore) remove(id string) ([]dbSavedQuery, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if err := st.loadLocked(); err != nil {
		return nil, err
	}
	next := st.saved[:0:0]
	for _, q := range st.saved {
		if q.ID != id {
			next = append(next, q)
		}
	}
	prev := st.saved
	st.saved = next
	if err := st.saveLocked(); err != nil {
		st.saved = prev
		return nil, err
	}
	return append([]dbSavedQuery(nil), st.saved...), nil
}
