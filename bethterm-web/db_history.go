package main

// db_history.go — histórico geral das consultas executadas no editor, de
// todas as conexões e bancos (db-history.jsonl, uma linha JSON por execução).
// Grava no servidor, no ponto em que a consulta realmente roda, então vale
// para qualquer janela. Guarda as últimas dbHistoryKeep execuções.
//
//	POST /api/db/history         {q?, connId?, failed?, limit?, offset?} -> {items, total}
//	POST /api/db/history/delete  {id}                                    -> {ok}
//	POST /api/db/history/clear   {}                                      -> {ok}

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	dbHistoryFile = "db-history.jsonl"
	dbHistoryKeep = 5000
	// passou disto, a próxima gravação reescreve o arquivo só com as últimas
	dbHistorySlack   = 500
	dbHistorySQLMax  = 64 << 10
	dbHistoryPage    = 200
	dbHistoryMaxPage = 1000
)

type dbHistoryEntry struct {
	ID       string `json:"id"`
	ConnID   string `json:"connId"`
	ConnName string `json:"connName"`
	Driver   string `json:"driver"`
	Database string `json:"database"`
	SQL      string `json:"sql"`
	At       string `json:"at"` // RFC3339 UTC
	MS       int64  `json:"ms"`
	Rows     int    `json:"rows"`
	Error    string `json:"error,omitempty"`
}

type dbHistoryStore struct {
	mu    sync.Mutex
	dir   string
	lines int // linhas no arquivo (-1 = ainda não contou)
}

var dbHistory = &dbHistoryStore{lines: -1}

func (st *dbHistoryStore) path() string {
	d := st.dir
	if d == "" {
		d = dataDir()
	}
	return filepath.Join(d, dbHistoryFile)
}

func (st *dbHistoryStore) readLocked() ([]dbHistoryEntry, error) {
	b, err := os.ReadFile(st.path())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var out []dbHistoryEntry
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 0, 64<<10), 4*dbHistorySQLMax)
	for sc.Scan() {
		var e dbHistoryEntry
		if json.Unmarshal(sc.Bytes(), &e) == nil && e.ID != "" {
			out = append(out, e)
		}
	}
	return out, nil
}

func (st *dbHistoryStore) rewriteLocked(list []dbHistoryEntry) error {
	var buf bytes.Buffer
	for _, e := range list {
		b, err := json.Marshal(e)
		if err != nil {
			continue
		}
		buf.Write(b)
		buf.WriteByte('\n')
	}
	if err := writeAtomic(st.path(), buf.Bytes()); err != nil {
		return err
	}
	st.lines = len(list)
	return nil
}

// add acrescenta uma execução. Nunca devolve erro ao chamador de propósito:
// o histórico não pode atrapalhar a consulta.
func (st *dbHistoryStore) add(e dbHistoryEntry) {
	e.SQL = strings.TrimSpace(strings.ToValidUTF8(e.SQL, ""))
	if e.SQL == "" {
		return
	}
	if len(e.SQL) > dbHistorySQLMax {
		e.SQL = strings.ToValidUTF8(e.SQL[:dbHistorySQLMax], "") + "\n… (cortado)"
	}
	if e.ID == "" {
		e.ID = dbNewID()
	}
	if e.At == "" {
		e.At = time.Now().UTC().Format(time.RFC3339)
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(st.path()), 0o755); err != nil {
		return
	}
	line, err := json.Marshal(e)
	if err != nil {
		return
	}
	f, err := os.OpenFile(st.path(), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	_, werr := f.Write(append(line, '\n'))
	f.Close()
	if werr != nil {
		return
	}
	if st.lines < 0 {
		if all, err := st.readLocked(); err == nil {
			st.lines = len(all)
		}
	} else {
		st.lines++
	}
	if st.lines > dbHistoryKeep+dbHistorySlack {
		if all, err := st.readLocked(); err == nil && len(all) > dbHistoryKeep {
			_ = st.rewriteLocked(all[len(all)-dbHistoryKeep:])
		}
	}
}

// dbHistoryMatch: todos os termos (separados por espaço) aparecem no SQL, no
// nome da conexão ou no banco, sem diferenciar maiúsculas.
func dbHistoryMatch(e dbHistoryEntry, terms []string) bool {
	hay := strings.ToLower(e.SQL + "\n" + e.ConnName + "\n" + e.Database)
	for _, t := range terms {
		if !strings.Contains(hay, t) {
			return false
		}
	}
	return true
}

type dbHistoryQuery struct {
	Q      string `json:"q"`
	ConnID string `json:"connId"`
	Failed bool   `json:"failed"`
	Limit  int    `json:"limit"`
	Offset int    `json:"offset"`
}

// search devolve a página (mais recente primeiro) e o total que casa.
func (st *dbHistoryStore) search(q dbHistoryQuery) ([]dbHistoryEntry, int, error) {
	st.mu.Lock()
	all, err := st.readLocked()
	st.mu.Unlock()
	if err != nil {
		return nil, 0, err
	}
	terms := strings.Fields(strings.ToLower(q.Q))
	limit := q.Limit
	if limit <= 0 {
		limit = dbHistoryPage
	}
	if limit > dbHistoryMaxPage {
		limit = dbHistoryMaxPage
	}
	offset := q.Offset
	if offset < 0 {
		offset = 0
	}
	items := []dbHistoryEntry{}
	total := 0
	for i := len(all) - 1; i >= 0; i-- {
		e := all[i]
		if q.ConnID != "" && e.ConnID != q.ConnID {
			continue
		}
		if q.Failed && e.Error == "" {
			continue
		}
		if !dbHistoryMatch(e, terms) {
			continue
		}
		if total >= offset && len(items) < limit {
			items = append(items, e)
		}
		total++
	}
	return items, total, nil
}

func (st *dbHistoryStore) remove(id string) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	all, err := st.readLocked()
	if err != nil {
		return err
	}
	next := all[:0:0]
	for _, e := range all {
		if e.ID != id {
			next = append(next, e)
		}
	}
	if len(next) == len(all) {
		return nil
	}
	return st.rewriteLocked(next)
}

func (st *dbHistoryStore) clear() error {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.rewriteLocked(nil)
}

func (s *server) dbHistoryAPI(w http.ResponseWriter, path string, body []byte) {
	switch path {
	case "history":
		var q dbHistoryQuery
		if len(bytes.TrimSpace(body)) > 0 && json.Unmarshal(body, &q) != nil {
			dbFail(w, http.StatusBadRequest, errors.New("requisição inválida"))
			return
		}
		items, total, err := dbHistory.search(q)
		if err != nil {
			dbFail(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": total})
	case "history/delete":
		var req struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(body, &req) != nil || req.ID == "" {
			dbFail(w, http.StatusBadRequest, errors.New("id inválido"))
			return
		}
		if err := dbHistory.remove(req.ID); err != nil {
			dbFail(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case "history/clear":
		if err := dbHistory.clear(); err != nil {
			dbFail(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}
