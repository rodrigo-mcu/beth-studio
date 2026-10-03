package main

// db_exec.go — pools, query execution with hard limits, cancellation and the
// "load more" cursor, plus the table data view (paging, sort, filter).
//
// Limits (all enforced here, whatever the page asks for):
//   - query timeout: default 60 s, at most 600 s;
//   - rows per result set per request: default 1 000, at most 10 000;
//   - rows kept reachable through "load more": at most 100 000 per result;
//   - response size: about 16 MiB of cell data per request;
//   - one cell: at most 64 KiB of text (binary shown as hex, 4 KiB).
//
// Read-only connections (and every connection when the app runs with
// --read-only) execute inside a transaction opened with ReadOnly where the
// driver supports it (PostgreSQL, MySQL, SQLite) and that transaction is
// always rolled back. SQLite read-only connections also open the file with
// mode=ro and query_only. Statements that are not plain reads are refused
// before anything is sent.
//
// Nothing here logs SQL text, parameters, results or passwords.

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	dbDefaultTimeout   = 60 * time.Second
	dbMaxTimeout       = 600 * time.Second
	dbDefaultPageRows  = 1000
	dbMaxPageRows      = 10000
	dbMaxTotalRows     = 100000
	dbMaxResponseBytes = 16 << 20
	dbMaxCellText      = 64 << 10
	dbMaxCellBinary    = 4 << 10
	dbMaxStatements    = 200
	dbMaxSQLBytes      = 512 << 10
	dbCursorIdle       = 3 * time.Minute
	dbMaxCursors       = 8
	dbPoolIdle         = 10 * time.Minute
)

// ---------- pools ----------

type dbPoolEntry struct {
	db       *sql.DB
	finger   string
	lastUsed time.Time
}

type dbPoolCache struct {
	mu    sync.Mutex
	pools map[string]*dbPoolEntry // id + "\x00" + database
	once  sync.Once
}

var dbPools = &dbPoolCache{pools: map[string]*dbPoolEntry{}}

func init() {
	dbConns.onChange = dbPools.drop
}

func dbFingerprint(c DBConnConfig, password string) string {
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%s\x00%s\x00%d\x00%s\x00%s\x00%s\x00%s\x00%v\x00%v\x00%s\x00",
		c.Driver, c.Host, c.File, c.Port, c.Database, c.User, c.SSLMode, c.Tunnel, c.ReadOnly, c.CreateFile, password)
	return hex.EncodeToString(h.Sum(nil))
}

// get returns a pool for (c, database), reusing a cached one when the
// settings (and password) did not change.
func (pc *dbPoolCache) get(ctx context.Context, c DBConnConfig, password, database string) (*sql.DB, error) {
	pc.once.Do(func() { go pc.janitor() })
	key := c.ID + "\x00" + database
	fp := dbFingerprint(c, password)
	pc.mu.Lock()
	if e, ok := pc.pools[key]; ok {
		if e.finger == fp {
			e.lastUsed = time.Now()
			pc.mu.Unlock()
			return e.db, nil
		}
		delete(pc.pools, key)
		go e.db.Close()
	}
	pc.mu.Unlock()
	db, err := dbOpenPool(ctx, c, password, database)
	if err != nil {
		return nil, err
	}
	pc.mu.Lock()
	defer pc.mu.Unlock()
	if e, ok := pc.pools[key]; ok && e.finger == fp { // lost a race: keep the first
		go db.Close()
		e.lastUsed = time.Now()
		return e.db, nil
	}
	pc.pools[key] = &dbPoolEntry{db: db, finger: fp, lastUsed: time.Now()}
	return db, nil
}

// drop closes every pool of a connection (after it was edited or deleted).
func (pc *dbPoolCache) drop(id string) {
	pc.mu.Lock()
	var closing []*sql.DB
	for k, e := range pc.pools {
		if strings.HasPrefix(k, id+"\x00") {
			closing = append(closing, e.db)
			delete(pc.pools, k)
		}
	}
	pc.mu.Unlock()
	for _, db := range closing {
		go db.Close()
	}
}

func (pc *dbPoolCache) janitor() {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for range t.C {
		pc.mu.Lock()
		for k, e := range pc.pools {
			if time.Since(e.lastUsed) > dbPoolIdle {
				delete(pc.pools, k)
				go e.db.Close()
			}
		}
		pc.mu.Unlock()
		dbCursors.expire()
	}
}

// ---------- values ----------

// dbCellValue converts a scanned value to something JSON can carry without
// losing information in JavaScript.
func dbCellValue(v any, dbType string) (out any, truncated bool, size int) {
	switch x := v.(type) {
	case nil:
		return nil, false, 4
	case bool:
		return x, false, 5
	case int64:
		if x > 1<<53 || x < -(1<<53) {
			s := strconv.FormatInt(x, 10)
			return s, false, len(s)
		}
		return x, false, 12
	case int32:
		return int64(x), false, 12
	case int:
		return dbCellValue(int64(x), dbType)
	case uint64:
		s := strconv.FormatUint(x, 10)
		return s, false, len(s)
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			s := strconv.FormatFloat(x, 'g', -1, 64)
			return s, false, len(s)
		}
		return x, false, 16
	case float32:
		return dbCellValue(float64(x), dbType)
	case time.Time:
		s := x.Format(time.RFC3339Nano)
		if x.Hour() == 0 && x.Minute() == 0 && x.Second() == 0 && x.Nanosecond() == 0 &&
			(strings.EqualFold(dbType, "DATE")) {
			s = x.Format("2006-01-02")
		}
		return s, false, len(s)
	case []byte:
		if strings.EqualFold(dbType, "UNIQUEIDENTIFIER") && len(x) == 16 {
			s := dbMSSQLGUID(x)
			return s, false, len(s)
		}
		if utf8.Valid(x) && !dbLooksBinaryType(dbType) {
			return dbCellValue(string(x), dbType)
		}
		b := x
		cut := false
		if len(b) > dbMaxCellBinary {
			b, cut = b[:dbMaxCellBinary], true
		}
		s := "0x" + strings.ToUpper(hex.EncodeToString(b))
		if cut {
			s += "…"
		}
		return s, cut, len(s)
	case string:
		if len(x) > dbMaxCellText {
			cut := x[:dbMaxCellText]
			for !utf8.ValidString(cut) && len(cut) > 0 {
				cut = cut[:len(cut)-1]
			}
			return cut + "…", true, len(cut)
		}
		return x, false, len(x) + 2
	case fmt.Stringer:
		return dbCellValue(x.String(), dbType)
	case driver.Valuer:
		vv, err := x.Value()
		if err == nil {
			return dbCellValue(vv, dbType)
		}
	}
	s := fmt.Sprint(v)
	return dbCellValue(s, dbType)
}

func dbLooksBinaryType(t string) bool {
	t = strings.ToUpper(t)
	return strings.Contains(t, "BLOB") || strings.Contains(t, "BINARY") || t == "BYTEA" || t == "IMAGE"
}

// dbMSSQLGUID formats SQL Server's mixed-endian uniqueidentifier bytes.
func dbMSSQLGUID(b []byte) string {
	return fmt.Sprintf("%02X%02X%02X%02X-%02X%02X-%02X%02X-%02X%02X-%02X%02X%02X%02X%02X%02X",
		b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15])
}

// ---------- result sets ----------

type dbResultColumn struct {
	Name string `json:"name"`
	Type string `json:"type,omitempty"`
}

// dbEditInfo is set when a SELECT reads one table and the result includes
// every primary-key column, so the grid can UPDATE a cell.
type dbEditInfo struct {
	Schema  string   `json:"schema"`
	Table   string   `json:"table"`
	PK      []string `json:"pk"`
	Columns []string `json:"columns"`
}

type dbResult struct {
	Statement      int              `json:"statement"` // index in the script
	SQL            string           `json:"sql"`       // first 300 chars
	Kind           dbStmtKind       `json:"kind"`
	Columns        []dbResultColumn `json:"columns"`
	Rows           [][]any          `json:"rows"`
	Edit           *dbEditInfo      `json:"edit,omitempty"`
	HasRows        bool             `json:"has_rows"` // false: command without a result set
	Affected       *int64           `json:"affected,omitempty"`
	HasMore        bool             `json:"has_more"`
	MoreID         string           `json:"more_id,omitempty"` // cursor kept open for "load more"
	Truncated      string           `json:"truncated,omitempty"`
	TruncatedCells int              `json:"truncated_cells,omitempty"`
	ElapsedMS      int64            `json:"elapsed_ms"`
}

func dbShortSQL(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) > 300 {
		r := []rune(s)
		return string(r[:300]) + "…"
	}
	return s
}

// dbBudget tracks the per-request response size.
type dbBudget struct{ left int }

// readRows reads up to max rows from the current result set. When rows
// remain it returns hasMore=true plus the one row it had to read to find out
// (database/sql cannot un-read a row); the caller keeps or drops it.
func readRows(rows *sql.Rows, res *dbResult, colTypes []string, max int, budget *dbBudget) (hasMore bool, peek []any, err error) {
	n := len(colTypes)
	vals := make([]any, n)
	ptrs := make([]any, n)
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	count := 0
	for {
		full := count >= max
		broke := budget.left <= 0
		if !rows.Next() {
			return false, nil, rows.Err()
		}
		if full || broke {
			if broke && !full {
				res.Truncated = "bytes"
			}
			if err := rows.Scan(ptrs...); err != nil {
				return false, nil, err
			}
			peek = make([]any, n)
			for i, v := range vals {
				peek[i], _, _ = dbCellValue(v, colTypes[i])
			}
			return true, peek, nil
		}
		if err := appendRow(rows, res, vals, ptrs, colTypes, budget); err != nil {
			return false, nil, err
		}
		count++
	}
}

func appendRow(rows *sql.Rows, res *dbResult, vals, ptrs []any, colTypes []string, budget *dbBudget) error {
	if err := rows.Scan(ptrs...); err != nil {
		return err
	}
	row := make([]any, len(vals))
	for i, v := range vals {
		cv, cut, sz := dbCellValue(v, colTypes[i])
		row[i] = cv
		if cut {
			res.TruncatedCells++
		}
		budget.left -= sz + 1
	}
	res.Rows = append(res.Rows, row)
	return nil
}

func columnsOf(rows *sql.Rows) ([]dbResultColumn, []string, error) {
	cts, err := rows.ColumnTypes()
	if err != nil {
		return nil, nil, err
	}
	cols := make([]dbResultColumn, len(cts))
	types := make([]string, len(cts))
	for i, ct := range cts {
		cols[i] = dbResultColumn{Name: ct.Name(), Type: ct.DatabaseTypeName()}
		types[i] = ct.DatabaseTypeName()
	}
	return cols, types, nil
}

// ---------- cursors ("load more") ----------

type dbCursor struct {
	id       string
	mu       sync.Mutex
	conn     *sql.Conn
	tx       *sql.Tx
	rows     *sql.Rows
	cancel   context.CancelFunc
	types    []string
	pending  []any // one row peeked by the previous read
	served   int
	lastUsed time.Time
	stmt     int
	sqlShort string
	kind     dbStmtKind
	discard  bool // conn changed session state: do not return it to the pool
}

type dbCursorTable struct {
	mu sync.Mutex
	m  map[string]*dbCursor
}

var dbCursors = &dbCursorTable{m: map[string]*dbCursor{}}

func (t *dbCursorTable) put(c *dbCursor) {
	t.mu.Lock()
	var evict []*dbCursor
	if len(t.m) >= dbMaxCursors {
		var oldest *dbCursor
		for _, x := range t.m {
			if oldest == nil || x.lastUsed.Before(oldest.lastUsed) {
				oldest = x
			}
		}
		if oldest != nil {
			delete(t.m, oldest.id)
			evict = append(evict, oldest)
		}
	}
	t.m[c.id] = c
	t.mu.Unlock()
	for _, x := range evict {
		x.close()
	}
}

func (t *dbCursorTable) take(id string) *dbCursor {
	t.mu.Lock()
	defer t.mu.Unlock()
	c := t.m[id]
	return c
}

func (t *dbCursorTable) remove(id string) {
	t.mu.Lock()
	c := t.m[id]
	delete(t.m, id)
	t.mu.Unlock()
	if c != nil {
		c.close()
	}
}

func (t *dbCursorTable) expire() {
	t.mu.Lock()
	var old []*dbCursor
	for id, c := range t.m {
		if time.Since(c.lastUsed) > dbCursorIdle {
			old = append(old, c)
			delete(t.m, id)
		}
	}
	t.mu.Unlock()
	for _, c := range old {
		c.close()
	}
}

func (t *dbCursorTable) count() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.m)
}

func (c *dbCursor) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.rows != nil {
		_ = c.rows.Close()
		c.rows = nil
	}
	if c.tx != nil {
		_ = c.tx.Rollback()
		c.tx = nil
	}
	if c.conn != nil {
		dbReleaseConn(c.conn, c.discard)
		c.conn = nil
	}
	if c.cancel != nil {
		c.cancel()
	}
}

// dbReleaseConn returns a connection to the pool, or throws it away when the
// script changed session/transaction state (an open BEGIN, SET, USE...), so
// the next user of the pool never inherits it.
func dbReleaseConn(conn *sql.Conn, discard bool) {
	if discard {
		_ = conn.Raw(func(any) error { return driver.ErrBadConn })
	}
	_ = conn.Close()
}

// ---------- running queries ----------

type dbRunning struct {
	cancel   context.CancelFunc
	started  time.Time
	timedOut bool
	mu       sync.Mutex
	// MySQL: o driver só fecha o lado do cliente ao cancelar; a consulta
	// (e os locks) continuam no servidor. kill manda KILL QUERY <id>.
	kill func()
	done bool // terminou: a conexão pode voltar ao pool, não matar mais nada
}

// stop: cancelar do usuário, estouro de tempo ou cliente que sumiu.
func (r *dbRunning) stop() {
	r.cancel()
	r.mu.Lock()
	k := r.kill
	if r.done {
		k = nil
	}
	r.kill = nil // uma vez só
	r.mu.Unlock()
	if k != nil {
		go k()
	}
}

// finish: chamar antes de devolver a conexão ao pool.
func (r *dbRunning) finish() {
	r.mu.Lock()
	r.done = true
	r.mu.Unlock()
}

// armKill (MySQL): guarda o id da conexão para o KILL QUERY. O KILL vai por
// outra conexão do pool. Depois do cancelamento o driver fecha esta, então
// o id não é reaproveitado por outra consulta deste processo.
func (r *dbRunning) armKill(ctx context.Context, db *sql.DB, d dbDriver, conn *sql.Conn) {
	if d != dbMySQL {
		return
	}
	var id uint64
	if err := conn.QueryRowContext(ctx, "SELECT CONNECTION_ID()").Scan(&id); err != nil || id == 0 {
		return
	}
	r.mu.Lock()
	r.kill = func() {
		kctx, c := context.WithTimeout(context.Background(), 5*time.Second)
		defer c()
		if _, err := db.ExecContext(kctx, "KILL QUERY "+strconv.FormatUint(id, 10)); err != nil {
			log.Printf("db: KILL QUERY %d: %v", id, err)
		}
	}
	r.mu.Unlock()
}

var (
	dbRunMu sync.Mutex
	dbRuns  = map[string]*dbRunning{}
)

func dbRegisterRun(id string, r *dbRunning) error {
	dbRunMu.Lock()
	defer dbRunMu.Unlock()
	if _, busy := dbRuns[id]; busy {
		return errors.New("já existe uma consulta em execução com este id")
	}
	dbRuns[id] = r
	return nil
}

func dbUnregisterRun(id string) {
	dbRunMu.Lock()
	delete(dbRuns, id)
	dbRunMu.Unlock()
}

// dbCancelRun cancels a running query or table read; true when one was found.
func dbCancelRun(id string) bool {
	dbRunMu.Lock()
	r := dbRuns[id]
	dbRunMu.Unlock()
	if r == nil {
		return false
	}
	r.stop()
	return true
}

// dbConfirmToken binds a confirmation to the exact script and target.
func dbConfirmToken(connID, database, sqlText string) string {
	h := sha256.Sum256([]byte(connID + "\x00" + database + "\x00" + sqlText))
	return hex.EncodeToString(h[:12])
}

type dbQueryOpts struct {
	QueryID  string
	MaxRows  int
	Timeout  time.Duration
	ReadOnly bool   // connection flag or app-wide --read-only
	Database string // current database, for unqualified table names
}

type dbQueryOutcome struct {
	Results    []dbResult `json:"results"`
	ElapsedMS  int64      `json:"elapsed_ms"`
	Error      string     `json:"error,omitempty"`
	ErrorStmt  *int       `json:"error_statement,omitempty"`
	ReadOnly   bool       `json:"read_only"`
	RolledBack bool       `json:"rolled_back,omitempty"`
	Discarded  bool       `json:"session_reset,omitempty"` // connection discarded after tx/session statements
}

// dbRunScript executes already-classified statements on one connection.
// Before calling it, the caller has refused writes on read-only connections
// and collected the user's confirmation for mutating statements.
func dbRunScript(parent context.Context, db *sql.DB, d dbDriver, stmts []dbStatement, o dbQueryOpts) (out dbQueryOutcome) {
	out = dbQueryOutcome{ReadOnly: o.ReadOnly, Results: []dbResult{}}
	t0 := time.Now()
	ctx, cancel := context.WithCancel(context.Background())
	run := &dbRunning{cancel: cancel, started: t0}
	if err := dbRegisterRun(o.QueryID, run); err != nil {
		cancel()
		out.Error = err.Error()
		return out
	}
	defer dbUnregisterRun(o.QueryID)
	stopParent := context.AfterFunc(parent, run.stop) // client went away
	timer := time.AfterFunc(o.Timeout, func() {
		run.mu.Lock()
		run.timedOut = true
		run.mu.Unlock()
		run.stop()
	})
	keepCtx := false
	defer func() {
		timer.Stop()
		stopParent()
		if !keepCtx {
			cancel()
		}
		out.ElapsedMS = time.Since(t0).Milliseconds()
	}()

	fail := func(i int, err error) {
		run.mu.Lock()
		to := run.timedOut
		run.mu.Unlock()
		out.Error = dbFriendlyError(ctx, err, to, o.Timeout)
		if i >= 0 {
			ii := i
			out.ErrorStmt = &ii
		}
	}

	conn, err := db.Conn(ctx)
	if err != nil {
		fail(-1, err)
		return out
	}
	run.armKill(ctx, db, d, conn)
	discard := false
	for _, s := range stmts {
		// SET (mesmo o SHOWPLAN, que conta como leitura) muda a sessão: a
		// conexão não volta para o pool, senão a próxima consulta herdaria
		// o estado se o envio falhar antes do SET ... OFF.
		if s.Kind == dbKindTx || s.Kind == dbKindSession || s.Kind == dbKindOther || s.FirstWord == "SET" {
			discard = true
		}
	}
	out.Discarded = discard && !o.ReadOnly
	var tx *sql.Tx
	var q interface {
		QueryContext(context.Context, string, ...any) (*sql.Rows, error)
		ExecContext(context.Context, string, ...any) (sql.Result, error)
	} = conn
	if o.ReadOnly {
		opts := &sql.TxOptions{ReadOnly: d != dbSQLServer}
		tx, err = conn.BeginTx(ctx, opts)
		if err != nil {
			dbReleaseConn(conn, true)
			fail(-1, err)
			return out
		}
		q = tx
		out.RolledBack = true
	}
	var held *dbCursor
	defer func() {
		run.finish()
		if held != nil {
			return // the cursor owns conn/tx now
		}
		if tx != nil {
			_ = tx.Rollback()
		}
		dbReleaseConn(conn, discard)
	}()

	budget := &dbBudget{left: dbMaxResponseBytes}
	for i, s := range stmts {
		st := time.Now()
		base := dbResult{Statement: i, SQL: dbShortSQL(s.SQL), Kind: s.Kind, Rows: [][]any{}}
		if !s.ReturnsRows {
			r, err := q.ExecContext(ctx, s.SQL)
			if err != nil {
				fail(i, err)
				return out
			}
			if n, err := r.RowsAffected(); err == nil && n >= 0 && s.Kind == dbKindWrite {
				base.Affected = &n
			}
			base.ElapsedMS = time.Since(st).Milliseconds()
			out.Results = append(out.Results, base)
			continue
		}
		rows, err := q.QueryContext(ctx, s.SQL)
		if err != nil {
			fail(i, err)
			return out
		}
		last := i == len(stmts)-1
		set := 0
		for {
			res := base
			res.Rows = [][]any{}
			cols, types, err := columnsOf(rows)
			if err != nil {
				rows.Close()
				fail(i, err)
				return out
			}
			res.Columns = cols
			res.HasRows = len(cols) > 0
			more := false
			var peek []any
			if len(cols) > 0 {
				more, peek, err = readRows(rows, &res, types, o.MaxRows, budget)
				if err != nil {
					rows.Close()
					fail(i, err)
					return out
				}
			}
			res.ElapsedMS = time.Since(st).Milliseconds()
			if more {
				res.HasMore = true
				if res.Truncated == "" {
					res.Truncated = "rows"
				}
				if last && res.Truncated == "rows" {
					// Keep the cursor: "load more" continues from here.
					cur := &dbCursor{
						id: o.QueryID + "-" + strconv.Itoa(i) + "-" + strconv.Itoa(set), conn: conn, tx: tx, rows: rows,
						cancel: cancel, types: types, pending: peek, served: len(res.Rows),
						lastUsed: time.Now(), stmt: i, sqlShort: res.SQL, kind: s.Kind, discard: discard,
					}
					res.MoreID = cur.id
					held = cur
					keepCtx = true
					dbCursors.put(cur)
					out.Results = append(out.Results, res)
					return out
				}
				// Earlier statements (or out of budget): drop the rest.
				res.HasMore = false
				out.Results = append(out.Results, res)
				rows.Close()
				break
			}
			out.Results = append(out.Results, res)
			set++
			if !rows.NextResultSet() {
				if err := rows.Err(); err != nil {
					rows.Close()
					fail(i, err)
					return out
				}
				rows.Close()
				break
			}
		}
		if err := ctx.Err(); err != nil {
			fail(i, err)
			return out
		}
	}
	return out
}

// dbMoreRows continues a kept cursor.
type dbMoreOutcome struct {
	Rows           [][]any `json:"rows"`
	HasMore        bool    `json:"has_more"`
	Truncated      string  `json:"truncated,omitempty"`
	TruncatedCells int     `json:"truncated_cells,omitempty"`
	ElapsedMS      int64   `json:"elapsed_ms"`
	Error          string  `json:"error,omitempty"`
}

func dbMoreRows(id string, max int, timeout time.Duration) dbMoreOutcome {
	out := dbMoreOutcome{Rows: [][]any{}}
	c := dbCursors.take(id)
	if c == nil {
		out.Error = "o resultado não está mais disponível (expirou ou foi fechado); execute a consulta de novo"
		return out
	}
	t0 := time.Now()
	if dbRegisterRun(id, &dbRunning{cancel: c.cancel, started: t0}) == nil {
		defer dbUnregisterRun(id)
	}
	c.mu.Lock()
	if c.rows == nil {
		c.mu.Unlock()
		out.Error = "o resultado já foi fechado"
		return out
	}
	timedOut := false
	var tmu sync.Mutex
	timer := time.AfterFunc(timeout, func() {
		tmu.Lock()
		timedOut = true
		tmu.Unlock()
		c.cancel()
	})
	res := dbResult{Rows: [][]any{}}
	budget := &dbBudget{left: dbMaxResponseBytes}
	if c.pending != nil {
		res.Rows = append(res.Rows, c.pending)
		c.pending = nil
		max--
	}
	if room := dbMaxTotalRows - c.served - len(res.Rows); max > room {
		max = room
	}
	var more bool
	var err error
	if max > 0 {
		more, c.pending, err = readRows(c.rows, &res, c.types, max, budget)
	} else {
		more = true
	}
	timer.Stop()
	c.served += len(res.Rows)
	c.lastUsed = time.Now()
	c.mu.Unlock()
	out.Rows = res.Rows
	out.TruncatedCells = res.TruncatedCells
	out.ElapsedMS = time.Since(t0).Milliseconds()
	if err != nil {
		tmu.Lock()
		to := timedOut
		tmu.Unlock()
		out.Error = dbFriendlyError(context.Background(), err, to, timeout)
		dbCursors.remove(id)
		return out
	}
	if more && c.served >= dbMaxTotalRows {
		out.Truncated = "limit"
		more = false
	} else if res.Truncated == "bytes" {
		out.Truncated = "bytes"
	}
	out.HasMore = more
	if !more {
		dbCursors.remove(id)
	}
	return out
}

// dbFriendlyError turns driver errors into pt-BR messages (the driver text
// is kept, it carries the server's explanation).
func dbFriendlyError(ctx context.Context, err error, timedOut bool, timeout time.Duration) string {
	if timedOut {
		return fmt.Sprintf("tempo limite de %d s atingido: a consulta foi cancelada", int(timeout/time.Second))
	}
	if errors.Is(err, context.Canceled) || (ctx != nil && errors.Is(ctx.Err(), context.Canceled)) {
		return "consulta cancelada"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "tempo limite atingido"
	}
	msg := err.Error()
	low := strings.ToLower(msg)
	switch {
	case strings.Contains(low, "read-only transaction") || strings.Contains(low, "read only transaction") ||
		strings.Contains(low, "attempt to write a readonly database") || strings.Contains(low, "query_only"):
		return "conexão somente leitura: o banco recusou a alteração (" + msg + ")"
	case strings.Contains(low, "connection refused") || strings.Contains(low, "actively refused") || strings.Contains(low, "no connection could be made") ||
		strings.Contains(low, "recusou ativamente") || strings.Contains(low, "nenhuma conexão pôde ser feita"):
		return "não foi possível conectar ao servidor (conexão recusada): " + msg
	case strings.Contains(low, "i/o timeout") || strings.Contains(low, "dial tcp") && strings.Contains(low, "timeout"):
		return "o servidor não respondeu (tempo esgotado): " + msg
	case strings.Contains(low, "no such host"):
		return "servidor não encontrado (nome não resolvido): " + msg
	case strings.Contains(low, "password authentication failed") || strings.Contains(low, "access denied") || strings.Contains(low, "login failed"):
		return "usuário ou senha recusados: " + msg
	}
	return msg
}

// ---------- table data view ----------

type dbSort struct {
	Column string `json:"column"`
	Desc   bool   `json:"desc"`
}

type dbFilter struct {
	Column string `json:"column"`
	Op     string `json:"op"` // eq ne lt le gt ge contains starts ends null notnull
	Value  string `json:"value"`
}

// dbBuildTableQuery builds the SELECT for the data view. Column names must
// already be validated against the catalog; values always travel as bind
// parameters.
// pk: chave primária da tabela, usada como desempate da ordem (ou como a
// ordem, sem ordenação escolhida). Sem ordem total, LIMIT/OFFSET pode
// repetir ou pular linhas entre páginas.
func dbBuildTableQuery(d dbDriver, schema, table string, cols map[string]bool, pk []string, sorts []dbSort, filters []dbFilter, limit, offset int) (string, string, []any, error) {
	from := dbQualified(d, schema, table)
	var where []string
	var args []any
	for _, f := range filters {
		if !cols[f.Column] {
			return "", "", nil, fmt.Errorf("coluna desconhecida: %s", f.Column)
		}
		col := dbQuoteIdent(d, f.Column)
		ph := func() string {
			return dbPlaceholder(d, len(args))
		}
		switch f.Op {
		case "eq", "ne", "lt", "le", "gt", "ge":
			op := map[string]string{"eq": "=", "ne": "<>", "lt": "<", "le": "<=", "gt": ">", "ge": ">="}[f.Op]
			args = append(args, f.Value)
			where = append(where, col+" "+op+" "+ph())
		case "contains", "starts", "ends":
			pat := dbLikeEscape(d, f.Value)
			switch f.Op {
			case "contains":
				pat = "%" + pat + "%"
			case "starts":
				pat = pat + "%"
			case "ends":
				pat = "%" + pat
			}
			args = append(args, pat)
			like := "LIKE"
			if d == dbPostgres {
				like = "ILIKE"
			}
			where = append(where, dbTextCast(d, col)+" "+like+" "+ph()+" ESCAPE '!'")
		case "null":
			where = append(where, col+" IS NULL")
		case "notnull":
			where = append(where, col+" IS NOT NULL")
		default:
			return "", "", nil, fmt.Errorf("filtro inválido: %s", f.Op)
		}
	}
	w := ""
	if len(where) > 0 {
		w = " WHERE " + strings.Join(where, " AND ")
	}
	var order []string
	for _, s := range sorts {
		if !cols[s.Column] {
			return "", "", nil, fmt.Errorf("coluna desconhecida: %s", s.Column)
		}
		dir := " ASC"
		if s.Desc {
			dir = " DESC"
		}
		order = append(order, dbQuoteIdent(d, s.Column)+dir)
	}
	for _, p := range pk {
		if !cols[p] {
			continue
		}
		sorted := false
		for _, s := range sorts {
			sorted = sorted || s.Column == p
		}
		if !sorted {
			order = append(order, dbQuoteIdent(d, p)+" ASC")
		}
	}
	ob := ""
	if len(order) > 0 {
		ob = " ORDER BY " + strings.Join(order, ", ")
	}
	var q string
	if d == dbSQLServer {
		if ob == "" {
			ob = " ORDER BY (SELECT NULL)"
		}
		q = fmt.Sprintf("SELECT * FROM %s%s%s OFFSET %d ROWS FETCH NEXT %d ROWS ONLY", from, w, ob, offset, limit)
	} else {
		q = fmt.Sprintf("SELECT * FROM %s%s%s LIMIT %d OFFSET %d", from, w, ob, limit, offset)
	}
	count := "SELECT COUNT(*) FROM " + from + w
	return q, count, args, nil
}

// dbLikeEscape escapes LIKE wildcards with '!' (same ESCAPE clause everywhere).
func dbLikeEscape(d dbDriver, v string) string {
	r := strings.NewReplacer("!", "!!", "%", "!%", "_", "!_")
	v = r.Replace(v)
	if d == dbSQLServer {
		v = strings.ReplaceAll(v, "[", "![")
	}
	return v
}

type dbTableOutcome struct {
	Columns        []dbResultColumn `json:"columns"`
	Rows           [][]any          `json:"rows"`
	HasMore        bool             `json:"has_more"`
	Total          *int64           `json:"total,omitempty"`
	TruncatedCells int              `json:"truncated_cells,omitempty"`
	ElapsedMS      int64            `json:"elapsed_ms"`
	Error          string           `json:"error,omitempty"`
}

// dbReadTable runs the data view query (always inside a transaction that is
// rolled back when the connection is read-only).
func dbReadTable(parent context.Context, db *sql.DB, d dbDriver, queryID string, readOnly bool, query, countQuery string, args []any, limit int, withCount bool, timeout time.Duration) dbTableOutcome {
	out := dbTableOutcome{Rows: [][]any{}}
	t0 := time.Now()
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	run := &dbRunning{cancel: cancel, started: t0}
	if queryID != "" {
		if err := dbRegisterRun(queryID, run); err != nil {
			out.Error = err.Error()
			return out
		}
		defer dbUnregisterRun(queryID)
	}
	timedOut := false
	var tmu sync.Mutex
	timer := time.AfterFunc(timeout, func() {
		tmu.Lock()
		timedOut = true
		tmu.Unlock()
		run.stop()
	})
	defer timer.Stop()
	fail := func(err error) dbTableOutcome {
		tmu.Lock()
		to := timedOut
		tmu.Unlock()
		out.Error = dbFriendlyError(ctx, err, to, timeout)
		out.ElapsedMS = time.Since(t0).Milliseconds()
		return out
	}
	conn, err := db.Conn(ctx)
	if err != nil {
		return fail(err)
	}
	run.armKill(ctx, db, d, conn)
	defer func() {
		run.finish()
		dbReleaseConn(conn, false)
	}()
	var q queryer = conn
	if readOnly {
		tx, err := conn.BeginTx(ctx, &sql.TxOptions{ReadOnly: d != dbSQLServer})
		if err != nil {
			return fail(err)
		}
		defer tx.Rollback()
		q = tx
	}
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return fail(err)
	}
	cols, types, err := columnsOf(rows)
	if err != nil {
		rows.Close()
		return fail(err)
	}
	out.Columns = cols
	res := dbResult{Rows: [][]any{}}
	budget := &dbBudget{left: dbMaxResponseBytes}
	more, _, err := readRows(rows, &res, types, limit, budget)
	rows.Close()
	if err != nil {
		return fail(err)
	}
	out.Rows, out.HasMore, out.TruncatedCells = res.Rows, more, res.TruncatedCells
	if withCount {
		var n int64
		r, err := q.QueryContext(ctx, countQuery, args...)
		if err != nil {
			return fail(err)
		}
		if r.Next() {
			if err := r.Scan(&n); err != nil {
				r.Close()
				return fail(err)
			}
		}
		r.Close()
		out.Total = &n
	}
	out.ElapsedMS = time.Since(t0).Milliseconds()
	return out
}

func dbLogf(format string, args ...any) {
	log.Printf("db: "+format, args...)
}
