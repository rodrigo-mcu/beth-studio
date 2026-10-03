package main

// db_api.go — HTTP routes of the "Banco de dados" panel, all under /api/db/.
// Authentication (token, Host and Origin checks) is done by server.go before
// serveDB is called.
//
//	GET  /api/db/connections          list + driver catalog + limits
//	POST /api/db/connections/save     {connection, password?, clear_password?}
//	POST /api/db/connections/delete   {id}
//	POST /api/db/test                 {id?} | {connection, password?}
//	POST /api/db/databases            {id}
//	POST /api/db/schemas              {id, database?, system?}
//	POST /api/db/objects              {id, database?, schema}
//	POST /api/db/columns              {id, database?, schema, table}
//	POST /api/db/table                {id, database?, schema, table, sort, filters, limit, offset, count, query_id}
//	POST /api/db/assist               {id, mode: fix|ask, sql?, question?, database?}
//	POST /api/db/query                {id, database?, sql, max_rows, timeout_s, confirm, query_id}
//	POST /api/db/more                 {more_id, max_rows, timeout_s}
//	POST /api/db/cancel               {query_id}
//	POST /api/db/close                {more_id}
//
// Errors in the request itself answer 400 {error}. Database errors of a
// query answer 200 with "error" set, so partial results are still shown.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const dbBrowseTimeout = 30 * time.Second

var dbQueryIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)

func (s *server) dbAppReadOnly() bool { return s != nil && s.hub != nil && s.hub.readOnly }

// serveDB dispatches every /api/db/ route.
func (s *server) serveDB(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/db/")
	if path == "connections" {
		if r.Method != http.MethodGet {
			dbFail(w, http.StatusMethodNotAllowed, errors.New("método não permitido"))
			return
		}
		s.dbListConnections(w)
		return
	}
	if path == "queries" && r.Method == http.MethodGet {
		s.dbListQueries(w)
		return
	}
	if r.Method != http.MethodPost {
		dbFail(w, http.StatusMethodNotAllowed, errors.New("método não permitido"))
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, dbMaxSQLBytes+64<<10))
	if err != nil {
		dbFail(w, http.StatusRequestEntityTooLarge, errors.New("requisição grande demais"))
		return
	}
	switch path {
	case "connections/save":
		s.dbSaveConnection(w, body)
	case "connections/delete":
		s.dbDeleteConnection(w, body)
	case "test":
		s.dbTest(w, r, body)
	case "databases", "schemas", "objects", "columns":
		s.dbBrowse(w, r, path, body)
	case "table":
		s.dbTable(w, r, body)
	case "query":
		s.dbQuery(w, r, body)
	case "row":
		s.dbUpdateRow(w, r, body)
	case "apply":
		s.dbApplyRows(w, r, body)
	case "assist":
		s.dbAssist(w, r, body)
	case "window":
		if err := openDBWindow(); err != nil {
			dbFail(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case "more":
		s.dbMore(w, body)
	case "cancel":
		var req struct {
			QueryID string `json:"query_id"`
		}
		if err := json.Unmarshal(body, &req); err != nil || !dbQueryIDRe.MatchString(req.QueryID) {
			dbFail(w, http.StatusBadRequest, errors.New("id de consulta inválido"))
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"cancelled": dbCancelRun(req.QueryID)})
	case "queries":
		s.dbListQueries(w)
	case "queries/save":
		s.dbSaveQuery(w, body)
	case "queries/delete":
		s.dbDeleteQuery(w, body)
	case "history", "history/delete", "history/clear":
		s.dbHistoryAPI(w, path, body)
	case "close":
		var req struct {
			MoreID string `json:"more_id"`
		}
		if err := json.Unmarshal(body, &req); err != nil || !dbQueryIDRe.MatchString(req.MoreID) {
			dbFail(w, http.StatusBadRequest, errors.New("id inválido"))
			return
		}
		dbCursors.remove(req.MoreID)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		dbFail(w, http.StatusNotFound, errors.New("rota desconhecida"))
	}
}

func (s *server) dbListQueries(w http.ResponseWriter) {
	list, err := dbQueries.list()
	if err != nil {
		dbFail(w, http.StatusInternalServerError, err)
		return
	}
	if list == nil {
		list = []dbSavedQuery{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"saved": list})
}

func (s *server) dbSaveQuery(w http.ResponseWriter, body []byte) {
	var req struct {
		ConnID string `json:"connId"`
		Name   string `json:"name"`
		SQL    string `json:"sql"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		dbFail(w, http.StatusBadRequest, errors.New("requisição inválida"))
		return
	}
	list, err := dbQueries.save(req.ConnID, req.Name, req.SQL)
	if err != nil {
		dbFail(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"saved": list})
}

func (s *server) dbDeleteQuery(w http.ResponseWriter, body []byte) {
	var req struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(body, &req); err != nil || req.ID == "" {
		dbFail(w, http.StatusBadRequest, errors.New("id inválido"))
		return
	}
	list, err := dbQueries.remove(req.ID)
	if err != nil {
		dbFail(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"saved": list})
}

func dbFail(w http.ResponseWriter, code int, err error) {
	writeJSON(w, code, map[string]string{"error": err.Error()})
}

func (s *server) dbListConnections(w http.ResponseWriter) {
	list, err := dbConns.list()
	if err != nil {
		dbFail(w, http.StatusInternalServerError, err)
		return
	}
	groups := []string{}
	seen := map[string]bool{}
	for _, c := range list {
		if c.Group != "" && !seen[strings.ToLower(c.Group)] {
			seen[strings.ToLower(c.Group)] = true
			groups = append(groups, c.Group)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"connections":   list,
		"groups":        groups,
		"drivers":       dbDrivers,
		"app_read_only": s.dbAppReadOnly(),
		"tunnel_ready":  dbTunnelProvider != nil,
		"limits": map[string]any{
			"default_timeout_s": int(dbDefaultTimeout / time.Second),
			"max_timeout_s":     int(dbMaxTimeout / time.Second),
			"default_rows":      dbDefaultPageRows,
			"max_rows":          dbMaxPageRows,
			"max_total_rows":    dbMaxTotalRows,
			"max_response_mb":   dbMaxResponseBytes >> 20,
		},
	})
}

func (s *server) dbSaveConnection(w http.ResponseWriter, body []byte) {
	var req struct {
		Connection    DBConnConfig `json:"connection"`
		Password      *string      `json:"password"`
		ClearPassword bool         `json:"clear_password"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		dbFail(w, http.StatusBadRequest, errors.New("requisição inválida"))
		return
	}
	v, err := dbConns.save(req.Connection, dbPasswordChange{Set: req.Password, Clear: req.ClearPassword})
	if err != nil {
		dbFail(w, http.StatusBadRequest, err)
		return
	}
	dbLogf("conexão salva id=%s driver=%s", v.ID, v.Driver)
	writeJSON(w, http.StatusOK, map[string]any{"connection": v})
}

func (s *server) dbDeleteConnection(w http.ResponseWriter, body []byte) {
	var req struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(body, &req); err != nil || !dbIDRe.MatchString(req.ID) {
		dbFail(w, http.StatusBadRequest, errors.New("id inválido"))
		return
	}
	if err := dbConns.remove(req.ID); err != nil {
		dbFail(w, http.StatusBadRequest, err)
		return
	}
	dbLogf("conexão apagada id=%s", req.ID)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// dbTest checks a saved or unsaved connection without caching the pool.
func (s *server) dbTest(w http.ResponseWriter, r *http.Request, body []byte) {
	var req struct {
		ID         string        `json:"id"`
		Connection *DBConnConfig `json:"connection"`
		Password   *string       `json:"password"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		dbFail(w, http.StatusBadRequest, errors.New("requisição inválida"))
		return
	}
	var cfg DBConnConfig
	var pw string
	if req.ID != "" {
		c, saved, err := dbConns.get(req.ID)
		if err != nil {
			dbFail(w, http.StatusBadRequest, err)
			return
		}
		cfg, pw = c, saved
	}
	if req.Connection != nil {
		c := *req.Connection
		c.ID = cfg.ID
		if err := dbValidateConfig(&c); err != nil {
			dbFail(w, http.StatusBadRequest, err)
			return
		}
		cfg = c
	}
	if cfg.Driver == "" {
		dbFail(w, http.StatusBadRequest, errors.New("informe a conexão"))
		return
	}
	if req.Password != nil {
		pw = *req.Password
	}
	if cfg.Driver == dbSQLite && cfg.CreateFile && !cfg.ReadOnly {
		if _, err := os.Stat(cfg.File); err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": "", "elapsed_ms": 0,
				"message": "o arquivo ainda não existe; ele será criado no primeiro uso"})
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), dbConnectTimeout+5*time.Second)
	defer cancel()
	t0 := time.Now()
	db, err := dbOpenPool(ctx, cfg, pw, "")
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": dbScrubErr(err, pw).Error()})
		return
	}
	defer db.Close()
	var version string
	err = db.QueryRowContext(ctx, dbVersionQuery(cfg.Driver)).Scan(&version)
	ms := time.Since(t0).Milliseconds()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": dbFriendlyError(ctx, dbScrubErr(err, pw), false, 0), "elapsed_ms": ms})
		return
	}
	if len(version) > 300 {
		version = version[:300]
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": strings.TrimSpace(version), "elapsed_ms": ms})
}

// dbTarget resolves the connection, password and pool of a request.
type dbTarget struct {
	cfg      DBConnConfig
	password string
	database string
}

func (s *server) dbResolve(ctx context.Context, id, database string) (dbTarget, error) {
	var t dbTarget
	if !dbIDRe.MatchString(id) {
		return t, errors.New("conexão inválida")
	}
	c, pw, err := dbConns.get(id)
	if err != nil {
		return t, err
	}
	database, err = dbCleanText("banco", database, 128)
	if err != nil {
		return t, err
	}
	if c.Driver == dbSQLite || c.Driver == dbMySQL {
		database = "" // no separate database level
	}
	if database == c.Database {
		database = ""
	}
	return dbTarget{cfg: c, password: pw, database: database}, nil
}

func (s *server) dbBrowse(w http.ResponseWriter, r *http.Request, what string, body []byte) {
	var req struct {
		ID       string `json:"id"`
		Database string `json:"database"`
		Schema   string `json:"schema"`
		Table    string `json:"table"`
		System   bool   `json:"system"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		dbFail(w, http.StatusBadRequest, errors.New("requisição inválida"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dbBrowseTimeout)
	defer cancel()
	t, err := s.dbResolve(ctx, req.ID, req.Database)
	if err != nil {
		dbFail(w, http.StatusBadRequest, err)
		return
	}
	db, err := dbPools.get(ctx, t.cfg, t.password, t.database)
	if err != nil {
		dbFail(w, http.StatusBadGateway, dbScrubErr(err, t.password))
		return
	}
	d := t.cfg.Driver
	var resp map[string]any
	switch what {
	case "databases":
		list, cur, e := dbListDatabases(ctx, d, db)
		err = e
		if list == nil {
			list = []string{}
		}
		resp = map[string]any{"databases": list, "current": cur}
	case "schemas":
		list, cur, e := dbListSchemas(ctx, d, db, req.System)
		err = e
		if list == nil {
			list = []string{}
		}
		resp = map[string]any{"schemas": list, "current": cur}
	case "objects":
		if req.Schema == "" {
			err = errors.New("informe o schema")
			break
		}
		objs, e := dbListObjects(ctx, d, db, req.Schema)
		err = e
		if objs == nil {
			objs = []dbObject{}
		}
		routines, rerr := dbListRoutines(ctx, d, db, req.Schema)
		if rerr != nil || routines == nil {
			routines = []dbRoutine{}
		}
		resp = map[string]any{"objects": objs, "routines": routines}
	case "columns":
		if req.Schema == "" || req.Table == "" {
			err = errors.New("informe schema e tabela")
			break
		}
		cols, e := dbListColumns(ctx, d, db, req.Schema, req.Table)
		if e != nil {
			err = e
			break
		}
		idx, e := dbListIndexes(ctx, d, db, req.Schema, req.Table)
		if e != nil {
			err = e
			break
		}
		if cols == nil {
			cols = []dbColumn{}
		}
		if idx == nil {
			idx = []dbIndex{}
		}
		resp = map[string]any{"columns": cols, "indexes": idx}
	}
	if err != nil {
		dbFail(w, http.StatusBadGateway, errors.New(dbFriendlyError(ctx, dbScrubErr(err, t.password), false, 0)))
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func dbClampTimeout(sec int) time.Duration {
	if sec <= 0 {
		return dbDefaultTimeout
	}
	d := time.Duration(sec) * time.Second
	if d > dbMaxTimeout {
		return dbMaxTimeout
	}
	return d
}

func dbClampRows(n int) int {
	if n <= 0 {
		return dbDefaultPageRows
	}
	if n > dbMaxPageRows {
		return dbMaxPageRows
	}
	return n
}

func (s *server) dbTable(w http.ResponseWriter, r *http.Request, body []byte) {
	var req struct {
		ID       string     `json:"id"`
		Database string     `json:"database"`
		Schema   string     `json:"schema"`
		Table    string     `json:"table"`
		Sort     []dbSort   `json:"sort"`
		Filters  []dbFilter `json:"filters"`
		Limit    int        `json:"limit"`
		Offset   int        `json:"offset"`
		Count    bool       `json:"count"`
		QueryID  string     `json:"query_id"`
		Timeout  int        `json:"timeout_s"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		dbFail(w, http.StatusBadRequest, errors.New("requisição inválida"))
		return
	}
	if req.QueryID != "" && !dbQueryIDRe.MatchString(req.QueryID) {
		dbFail(w, http.StatusBadRequest, errors.New("id de consulta inválido"))
		return
	}
	if req.Offset < 0 || req.Offset > 1<<40 || len(req.Sort) > 8 || len(req.Filters) > 20 {
		dbFail(w, http.StatusBadRequest, errors.New("parâmetros inválidos"))
		return
	}
	for _, f := range req.Filters {
		if len(f.Value) > 4096 {
			dbFail(w, http.StatusBadRequest, errors.New("valor de filtro longo demais"))
			return
		}
	}
	limit := dbClampRows(req.Limit)
	timeout := dbClampTimeout(req.Timeout)
	ctx, cancel := context.WithTimeout(r.Context(), dbBrowseTimeout)
	defer cancel()
	t, err := s.dbResolve(ctx, req.ID, req.Database)
	if err != nil {
		dbFail(w, http.StatusBadRequest, err)
		return
	}
	db, err := dbPools.get(ctx, t.cfg, t.password, t.database)
	if err != nil {
		dbFail(w, http.StatusBadGateway, dbScrubErr(err, t.password))
		return
	}
	d := t.cfg.Driver
	// Column names come from the catalog, never from the page as SQL.
	cols, err := dbListColumns(ctx, d, db, req.Schema, req.Table)
	if err != nil {
		dbFail(w, http.StatusBadGateway, errors.New(dbFriendlyError(ctx, dbScrubErr(err, t.password), false, 0)))
		return
	}
	if len(cols) == 0 {
		dbFail(w, http.StatusBadRequest, errors.New("tabela não encontrada"))
		return
	}
	known := map[string]bool{}
	var pk []string
	for _, c := range cols {
		known[c.Name] = true
		if c.PK {
			pk = append(pk, c.Name)
		}
	}
	q, cq, args, err := dbBuildTableQuery(d, req.Schema, req.Table, known, pk, req.Sort, req.Filters, limit+1, req.Offset) // +1: tells whether a next page exists
	if err != nil {
		dbFail(w, http.StatusBadRequest, err)
		return
	}
	ro := t.cfg.ReadOnly || s.dbAppReadOnly()
	out := dbReadTable(r.Context(), db, d, req.QueryID, ro, q, cq, args, limit, req.Count, timeout)
	if out.Error != "" {
		out.Error = dbScrubErr(errors.New(out.Error), t.password).Error()
	}
	dbLogf("tabela conn=%s linhas=%d ms=%d erro=%v", t.cfg.ID, len(out.Rows), out.ElapsedMS, out.Error != "")
	writeJSON(w, http.StatusOK, out)
}

func (s *server) dbQuery(w http.ResponseWriter, r *http.Request, body []byte) {
	var req struct {
		ID       string `json:"id"`
		Database string `json:"database"`
		SQL      string `json:"sql"`
		MaxRows  int    `json:"max_rows"`
		Timeout  int    `json:"timeout_s"`
		Confirm  string `json:"confirm"`
		QueryID  string `json:"query_id"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		dbFail(w, http.StatusBadRequest, errors.New("requisição inválida"))
		return
	}
	if !dbQueryIDRe.MatchString(req.QueryID) {
		dbFail(w, http.StatusBadRequest, errors.New("id de consulta inválido"))
		return
	}
	if len(req.SQL) > dbMaxSQLBytes {
		dbFail(w, http.StatusBadRequest, errors.New("SQL grande demais (máx. 512 KiB)"))
		return
	}
	t, err := s.dbResolve(r.Context(), req.ID, req.Database)
	if err != nil {
		dbFail(w, http.StatusBadRequest, err)
		return
	}
	stmts := dbSplitStatements(t.cfg.Driver, req.SQL)
	if len(stmts) == 0 {
		dbFail(w, http.StatusBadRequest, errors.New("nada para executar"))
		return
	}
	if len(stmts) > dbMaxStatements {
		dbFail(w, http.StatusBadRequest, errors.New("instruções demais num só envio (máx. 200)"))
		return
	}
	ro := t.cfg.ReadOnly || s.dbAppReadOnly()
	var mutating []dbConfirmItem
	for i, st := range stmts {
		if st.Mutating() {
			mutating = append(mutating, dbConfirmItem{Index: i, SQL: dbShortConfirm(st.SQL), Kind: st.Kind, Danger: st.Danger, Reason: st.Reason})
		}
	}
	if ro && len(mutating) > 0 {
		why := "esta conexão é somente leitura"
		if !t.cfg.ReadOnly {
			why = "o BethTerm Web foi aberto em modo somente leitura"
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"blocked":   mutating,
			"error":     why + ": só são aceitas consultas de leitura (" + dbKindLabel(mutating[0].Kind) + " na instrução " + strconv.Itoa(mutating[0].Index+1) + ")",
			"read_only": true,
		})
		return
	}
	token := dbConfirmToken(t.cfg.ID, req.Database, req.SQL)
	if len(mutating) > 0 && req.Confirm != token {
		danger := false
		for _, m := range mutating {
			danger = danger || m.Danger
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"needs_confirm": true,
			"confirm_token": token,
			"statements":    mutating,
			"danger":        danger,
			"total":         len(stmts),
		})
		return
	}
	db, err := dbPools.get(r.Context(), t.cfg, t.password, t.database)
	if err != nil {
		writeJSON(w, http.StatusOK, dbQueryOutcome{Results: []dbResult{}, Error: dbScrubErr(err, t.password).Error(), ReadOnly: ro})
		return
	}
	out := dbRunScript(r.Context(), db, t.cfg.Driver, stmts, dbQueryOpts{
		QueryID: req.QueryID, MaxRows: dbClampRows(req.MaxRows), Timeout: dbClampTimeout(req.Timeout), ReadOnly: ro,
		Database: t.database,
	})
	if out.Error == "" && !ro {
		dbAnnotateEdits(r.Context(), db, t.cfg.Driver, t.database, stmts, out.Results)
	}
	if out.Error != "" {
		out.Error = dbScrubErr(errors.New(out.Error), t.password).Error()
	}
	rowsN := 0
	for _, res := range out.Results {
		rowsN += len(res.Rows)
	}
	hdb := t.database
	if hdb == "" {
		hdb = t.cfg.Database
	}
	dbHistory.add(dbHistoryEntry{
		ConnID: t.cfg.ID, ConnName: t.cfg.Name, Driver: string(t.cfg.Driver), Database: hdb,
		SQL: req.SQL, MS: out.ElapsedMS, Rows: rowsN, Error: out.Error,
	})
	dbLogf("consulta conn=%s instrucoes=%d alteram=%d ro=%v linhas=%d ms=%d erro=%v",
		t.cfg.ID, len(stmts), len(mutating), ro, rowsN, out.ElapsedMS, out.Error != "")
	writeJSON(w, http.StatusOK, out)
}

func (s *server) dbMore(w http.ResponseWriter, body []byte) {
	var req struct {
		MoreID  string `json:"more_id"`
		MaxRows int    `json:"max_rows"`
		Timeout int    `json:"timeout_s"`
	}
	if err := json.Unmarshal(body, &req); err != nil || !dbQueryIDRe.MatchString(req.MoreID) {
		dbFail(w, http.StatusBadRequest, errors.New("id inválido"))
		return
	}
	out := dbMoreRows(req.MoreID, dbClampRows(req.MaxRows), dbClampTimeout(req.Timeout))
	writeJSON(w, http.StatusOK, out)
}

func dbShortConfirm(s string) string {
	const max = 4000
	if len(s) <= max {
		return s
	}
	return strings.ToValidUTF8(s[:max], "") + "\n… (" + strconv.Itoa(len(s)-max) + " caracteres a mais)"
}
