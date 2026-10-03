package main

// db_sqlclass.go — splits an SQL script into statements and says what each
// one does (read, write, schema change, transaction control...).
//
// The lexer understands the quoting rules of the four supported dialects:
// '...' strings ('' escape; backslash escapes in MySQL and in PostgreSQL
// E'...'), "..." identifiers (strings in MySQL), `...` identifiers
// (MySQL/SQLite), [...] identifiers (SQL Server/SQLite), -- and /* */
// comments (nested in PostgreSQL), # comments (MySQL) and PostgreSQL
// dollar quotes ($$...$$, $tag$...$tag$).
//
// This is a safety net, not a parser: it errs on the side of "this may
// write". Read-only connections additionally run inside a read-only
// transaction that is always rolled back (see db_exec.go).

import (
	"strings"
)

type dbStmtKind string

const (
	dbKindRead    dbStmtKind = "read"    // SELECT, WITH ... SELECT, SHOW, EXPLAIN, PRAGMA (query)...
	dbKindWrite   dbStmtKind = "write"   // INSERT, UPDATE, DELETE, MERGE, CALL/EXEC...
	dbKindDDL     dbStmtKind = "ddl"     // CREATE, ALTER, DROP, TRUNCATE, GRANT...
	dbKindTx      dbStmtKind = "tx"      // BEGIN, COMMIT, ROLLBACK, SAVEPOINT...
	dbKindSession dbStmtKind = "session" // SET, USE, PRAGMA x = y
	dbKindOther   dbStmtKind = "other"   // unknown: treated like a write
)

// dbStatement is one unit sent to the driver (for SQL Server, one GO batch).
type dbStatement struct {
	SQL         string     `json:"sql"`
	Kind        dbStmtKind `json:"kind"`
	FirstWord   string     `json:"first_word"`
	Danger      bool       `json:"danger"`
	Reason      string     `json:"reason,omitempty"` // pt-BR, shown in the confirmation dialog
	ReturnsRows bool       `json:"-"`
}

// Mutating reports whether the statement may change data, schema or session.
func (s dbStatement) Mutating() bool { return s.Kind != dbKindRead }

type sqlTok struct {
	kind  byte   // 'w' word, 'p' punctuation, 'q' quoted (string/identifier), 'n' number, 'g' GO batch separator
	text  string // words upper-cased; punctuation as is
	start int
	end   int
	depth int // parenthesis depth before the token
}

func isIdentStart(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c >= 0x80
}

func isIdentPart(c byte) bool {
	return isIdentStart(c) || (c >= '0' && c <= '9') || c == '$'
}

// dbLex tokenizes s. Unterminated strings/comments run to the end of input.
func dbLex(d dbDriver, s string) []sqlTok {
	var toks []sqlTok
	n := len(s)
	depth := 0
	i := 0
	for i < n {
		c := s[i]
		switch {
		case c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\f' || c == '\v':
			i++
		case c == '-' && i+1 < n && s[i+1] == '-':
			for i < n && s[i] != '\n' {
				i++
			}
		case c == '#' && d == dbMySQL:
			for i < n && s[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < n && s[i+1] == '*':
			i += 2
			nest := 1
			for i < n && nest > 0 {
				if s[i] == '*' && i+1 < n && s[i+1] == '/' {
					nest--
					i += 2
					continue
				}
				if d == dbPostgres && s[i] == '/' && i+1 < n && s[i+1] == '*' {
					nest++
					i += 2
					continue
				}
				i++
			}
		case c == '\'':
			start := i
			backslash := d == dbMySQL
			if d == dbPostgres && start > 0 && (s[start-1] == 'E' || s[start-1] == 'e') &&
				(start < 2 || !isIdentPart(s[start-2])) {
				backslash = true
			}
			i = scanQuoted(s, i+1, '\'', backslash)
			// An E prefix was lexed as a word: fold it into the string.
			if backslash && d == dbPostgres && len(toks) > 0 && toks[len(toks)-1].end == start && toks[len(toks)-1].text == "E" {
				toks = toks[:len(toks)-1]
				start--
			}
			toks = append(toks, sqlTok{kind: 'q', start: start, end: i, depth: depth})
		case c == '"':
			start := i
			i = scanQuoted(s, i+1, '"', d == dbMySQL)
			toks = append(toks, sqlTok{kind: 'q', start: start, end: i, depth: depth})
		case c == '`' && (d == dbMySQL || d == dbSQLite):
			start := i
			i = scanQuoted(s, i+1, '`', false)
			toks = append(toks, sqlTok{kind: 'q', start: start, end: i, depth: depth})
		case c == '[' && (d == dbSQLServer || d == dbSQLite):
			start := i
			i = scanQuoted(s, i+1, ']', false)
			toks = append(toks, sqlTok{kind: 'q', start: start, end: i, depth: depth})
		case c == '$' && d == dbPostgres && dollarTagEnd(s, i) > 0:
			start := i
			te := dollarTagEnd(s, i)
			tag := s[i:te]
			j := strings.Index(s[te:], tag)
			if j < 0 {
				i = n
			} else {
				i = te + j + len(tag)
			}
			toks = append(toks, sqlTok{kind: 'q', start: start, end: i, depth: depth})
		case isIdentStart(c) || ((c == '@' || c == '#') && d == dbSQLServer):
			start := i
			i++
			for i < n && (isIdentPart(s[i]) || ((s[i] == '@' || s[i] == '#') && d == dbSQLServer)) {
				i++
			}
			w := strings.ToUpper(s[start:i])
			t := sqlTok{kind: 'w', text: w, start: start, end: i, depth: depth}
			if d == dbSQLServer && w == "GO" && isGoLine(s, start, i) {
				t.kind = 'g'
				// swallow an optional repeat count on the same line
				for i < n && s[i] != '\n' {
					i++
				}
				t.end = i
			}
			toks = append(toks, t)
		case c >= '0' && c <= '9':
			start := i
			for i < n && (isIdentPart(s[i]) || s[i] == '.') {
				i++
			}
			toks = append(toks, sqlTok{kind: 'n', start: start, end: i, depth: depth})
		default:
			t := sqlTok{kind: 'p', text: string(c), start: i, end: i + 1, depth: depth}
			if c == '(' {
				depth++
			} else if c == ')' && depth > 0 {
				depth--
			}
			toks = append(toks, t)
			i++
		}
	}
	return toks
}

// scanQuoted returns the index after the closing quote (doubled quote = escape).
func scanQuoted(s string, i int, q byte, backslash bool) int {
	n := len(s)
	for i < n {
		c := s[i]
		if backslash && c == '\\' {
			i += 2
			continue
		}
		if c == q {
			if i+1 < n && s[i+1] == q {
				i += 2
				continue
			}
			return i + 1
		}
		i++
	}
	return n
}

// dollarTagEnd: for "$tag$" or "$$" at i returns the index after the second
// '$'; 0 when this is not a dollar quote (e.g. the parameter $1).
func dollarTagEnd(s string, i int) int {
	if i > 0 && isIdentPart(s[i-1]) {
		return 0 // part of an identifier like a$b
	}
	j := i + 1
	if j < len(s) && s[j] == '$' {
		return j + 1
	}
	if j >= len(s) || !(isIdentStart(s[j]) && s[j] != '$') {
		return 0
	}
	for j < len(s) && (isIdentStart(s[j]) || (s[j] >= '0' && s[j] <= '9')) {
		j++
	}
	if j < len(s) && s[j] == '$' {
		return j + 1
	}
	return 0
}

// isGoLine: the word at [a,b) is alone on its line (optionally followed by a
// repeat count), the SQL Server client batch separator.
func isGoLine(s string, a, b int) bool {
	for k := a - 1; k >= 0 && s[k] != '\n'; k-- {
		if s[k] != ' ' && s[k] != '\t' && s[k] != '\r' {
			return false
		}
	}
	for k := b; k < len(s) && s[k] != '\n'; k++ {
		c := s[k]
		if c != ' ' && c != '\t' && c != '\r' && !(c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}

var (
	dbReadFirst = map[string]bool{
		"SELECT": true, "WITH": true, "VALUES": true, "TABLE": true, "SHOW": true,
		"DESCRIBE": true, "DESC": true, "EXPLAIN": true, "PRAGMA": true, "HELP": true,
	}
	dbWriteFirst = map[string]bool{
		"INSERT": true, "UPDATE": true, "DELETE": true, "MERGE": true, "REPLACE": true,
		"UPSERT": true, "COPY": true, "LOAD": true, "IMPORT": true, "CALL": true,
		"EXEC": true, "EXECUTE": true, "DO": true, "HANDLER": true,
	}
	dbDDLFirst = map[string]bool{
		"CREATE": true, "ALTER": true, "DROP": true, "TRUNCATE": true, "RENAME": true,
		"COMMENT": true, "GRANT": true, "REVOKE": true, "VACUUM": true, "REINDEX": true,
		"ANALYZE": true, "ANALYSE": true, "CLUSTER": true, "REFRESH": true, "ATTACH": true,
		"DETACH": true, "OPTIMIZE": true, "REPAIR": true, "DBCC": true, "BACKUP": true,
		"RESTORE": true, "KILL": true, "SHUTDOWN": true, "LOCK": true, "UNLOCK": true,
		"FLUSH": true, "INSTALL": true, "UNINSTALL": true, "CHECKPOINT": true,
		"SECURITY": true, "REASSIGN": true, "DENY": true, "PURGE": true,
	}
	dbTxFirst = map[string]bool{
		"BEGIN": true, "START": true, "COMMIT": true, "ROLLBACK": true, "SAVEPOINT": true,
		"RELEASE": true, "END": true, "ABORT": true, "XA": true, "SAVE": true,
	}
	dbSessionFirst = map[string]bool{
		"SET": true, "USE": true, "RESET": true, "DISCARD": true, "LISTEN": true,
		"UNLISTEN": true, "NOTIFY": true, "PREPARE": true, "DEALLOCATE": true, "DECLARE": true,
		"FETCH": true, "CLOSE": true, "MOVE": true, "OPEN": true, "PRINT": true,
	}
	// SQLite pragmas that only read (with or without an argument).
	dbReadPragmas = map[string]bool{
		"TABLE_INFO": true, "TABLE_XINFO": true, "TABLE_LIST": true, "INDEX_LIST": true,
		"INDEX_INFO": true, "INDEX_XINFO": true, "FOREIGN_KEY_LIST": true, "FOREIGN_KEY_CHECK": true,
		"DATABASE_LIST": true, "COMPILE_OPTIONS": true, "PRAGMA_LIST": true, "COLLATION_LIST": true,
		"FUNCTION_LIST": true, "MODULE_LIST": true, "INTEGRITY_CHECK": true, "QUICK_CHECK": true,
	}
	// words that end a DML statement when scanning for its WHERE
	dbStmtStarters = map[string]bool{
		"SELECT": true, "INSERT": true, "UPDATE": true, "DELETE": true, "MERGE": true,
		"CREATE": true, "ALTER": true, "DROP": true, "TRUNCATE": true, "EXEC": true,
		"EXECUTE": true, "DECLARE": true, "END": true, "IF": true, "ELSE": true,
		"BEGIN": true, "COMMIT": true, "ROLLBACK": true, "RETURN": true, "PRINT": true,
	}
)

// dbSplitStatements splits a script into executable statements (SQL Server:
// GO batches) and classifies each one.
func dbSplitStatements(d dbDriver, text string) []dbStatement {
	toks := dbLex(d, text)
	var out []dbStatement
	emit := func(ts []sqlTok) {
		if len(ts) == 0 {
			return
		}
		sqlText := strings.TrimSpace(text[ts[0].start:ts[len(ts)-1].end])
		if sqlText == "" {
			return
		}
		st := dbClassifyTokens(d, ts)
		st.SQL = sqlText
		out = append(out, st)
	}
	if d == dbSQLServer {
		// One batch per GO; T-SQL does not need ';' between statements.
		start := 0
		for i, t := range toks {
			if t.kind == 'g' {
				emit(trimSemis(toks[start:i]))
				start = i + 1
			}
		}
		emit(trimSemis(toks[start:]))
		return out
	}
	start := 0
	routine := false // CREATE ... TRIGGER/FUNCTION/PROCEDURE/EVENT: BEGIN...END body
	block := 0
	for i := 0; i < len(toks); i++ {
		t := toks[i]
		if t.kind == 'w' {
			if i == start && t.text == "CREATE" {
				routine = false
			}
			if toks[start].kind == 'w' && toks[start].text == "CREATE" {
				switch t.text {
				case "TRIGGER", "FUNCTION", "PROCEDURE", "EVENT":
					routine = true
				}
			}
			if routine {
				switch t.text {
				case "BEGIN":
					block++
				case "CASE", "IF", "LOOP", "WHILE", "REPEAT":
					if block > 0 && !(i+1 < len(toks) && toks[i+1].text == "(") {
						block++
					}
				case "END":
					if block > 0 {
						block--
						if i+1 < len(toks) && toks[i+1].kind == 'w' {
							switch toks[i+1].text {
							case "IF", "LOOP", "WHILE", "REPEAT", "CASE":
								i++ // "END IF" closes one block, not two
							}
						}
					}
				}
			}
		}
		if t.kind == 'p' && t.text == ";" && t.depth == 0 && block == 0 {
			emit(toks[start:i])
			start = i + 1
			routine, block = false, 0
		}
	}
	emit(toks[start:])
	return out
}

func trimSemis(ts []sqlTok) []sqlTok {
	for len(ts) > 0 && ts[len(ts)-1].kind == 'p' && ts[len(ts)-1].text == ";" {
		ts = ts[:len(ts)-1]
	}
	for len(ts) > 0 && ts[0].kind == 'p' && ts[0].text == ";" {
		ts = ts[1:]
	}
	return ts
}

var dbKindRank = map[dbStmtKind]int{dbKindRead: 0, dbKindSession: 1, dbKindTx: 2, dbKindOther: 3, dbKindWrite: 4, dbKindDDL: 5}

func worse(a, b dbStmtKind) dbStmtKind {
	if dbKindRank[b] > dbKindRank[a] {
		return b
	}
	return a
}

func firstWordKind(w string) dbStmtKind {
	switch {
	case dbReadFirst[w]:
		return dbKindRead
	case dbWriteFirst[w]:
		return dbKindWrite
	case dbDDLFirst[w]:
		return dbKindDDL
	case dbTxFirst[w]:
		return dbKindTx
	case dbSessionFirst[w]:
		return dbKindSession
	}
	return dbKindOther
}

// isDMLVerb: token i is INSERT/UPDATE/DELETE/MERGE used as a statement, not
// as "FOR UPDATE", "ON DELETE CASCADE", "AFTER INSERT OR UPDATE ON",
// "GRANT SELECT, UPDATE ON", "ON DUPLICATE KEY UPDATE", "UPDATE OF col" or a
// function call like INSERT(...) in MySQL.
func isDMLVerb(ts []sqlTok, i int) bool {
	if i+1 < len(ts) {
		nx := ts[i+1]
		if nx.kind == 'p' && nx.text == "(" {
			return false
		}
		if nx.kind == 'w' && (nx.text == "OF" || nx.text == "ON") {
			return false
		}
	}
	if i > 0 {
		pv := ts[i-1]
		if pv.kind == 'p' && pv.text == "," {
			return false
		}
		if pv.kind == 'w' {
			switch pv.text {
			case "FOR", "ON", "KEY", "BEFORE", "AFTER", "OF", "OR", "GRANT", "REVOKE", "INSTEAD", "DENY":
				return false
			}
		}
	}
	return true
}

// dbClassifyTokens classifies one statement/batch.
func dbClassifyTokens(d dbDriver, ts []sqlTok) dbStatement {
	st := dbStatement{Kind: dbKindOther}
	var first string
	for _, t := range ts {
		if t.kind == 'w' {
			first = t.text
			break
		}
		if t.kind != 'p' || t.text != "(" {
			break // e.g. starts with a string or number
		}
	}
	st.FirstWord = first
	kind := firstWordKind(first)
	if d == dbSQLServer && (first == "DECLARE" || first == "PRINT") {
		kind = dbKindRead // T-SQL local variables; the scan below still escalates
	}
	if d == dbSQLServer && first == "BEGIN" {
		// BEGIN TRAN[SACTION] is transaction control; BEGIN ... END is a block.
		kind = dbKindRead
		if len(ts) > 1 && ts[1].kind == 'w' {
			switch ts[1].text {
			case "TRAN", "TRANSACTION", "DISTRIBUTED":
				kind = dbKindTx
			}
		}
	}
	if first == "PRAGMA" {
		kind = pragmaKind(ts)
	}
	// SET SHOWPLAN_TEXT|ALL|XML ON/OFF (o EXPLAIN do SQL Server): com ele ligado
	// o servidor só devolve o plano, não executa nada. Conta como leitura para
	// não pedir confirmação nem ser barrado em conexão somente leitura.
	showplan := d == dbSQLServer && first == "SET" && len(ts) > 1 && ts[1].kind == 'w' && strings.HasPrefix(ts[1].text, "SHOWPLAN_")
	if showplan {
		kind = dbKindRead
	}
	returnsRows := kind == dbKindRead && !showplan
	switch first {
	case "CALL", "EXEC", "EXECUTE":
		returnsRows = true
	}

	var reasons []string
	hasSelectVerb := false
	sawReturning := false
	for i, t := range ts {
		if t.kind != 'w' {
			continue
		}
		switch t.text {
		case "INSERT", "UPDATE", "DELETE", "MERGE":
			if isDMLVerb(ts, i) {
				kind = worse(kind, dbKindWrite)
				if (t.text == "UPDATE" || t.text == "DELETE") && !dmlHasWhere(ts, i) {
					st.Danger = true
					reasons = appendOnce(reasons, t.text+" sem WHERE: afeta todas as linhas da tabela")
				}
			}
		case "REPLACE", "UPSERT":
			if i == 0 && isDMLVerb(ts, i) {
				kind = worse(kind, dbKindWrite)
			}
		case "DROP", "TRUNCATE":
			if i+1 < len(ts) && ts[i+1].kind == 'p' && ts[i+1].text == "(" {
				continue
			}
			kind = worse(kind, dbKindDDL)
			st.Danger = true
			reasons = appendOnce(reasons, t.text+" apaga dados ou objetos de forma irreversível")
		case "CREATE", "ALTER", "GRANT", "REVOKE", "RENAME":
			if i+1 < len(ts) && ts[i+1].kind == 'p' && ts[i+1].text == "(" {
				continue
			}
			if i > 0 && ts[i-1].kind == 'w' && (ts[i-1].text == "SHOW" || ts[i-1].text == "WITH") {
				continue // SHOW CREATE TABLE, SHOW GRANTS; "WITH GRANT OPTION" is inside a GRANT anyway
			}
			kind = worse(kind, dbKindDDL)
		case "INTO":
			// SELECT ... INTO creates a table (PostgreSQL/SQL Server) or writes a file (MySQL).
			if first == "SELECT" || first == "WITH" {
				kind = worse(kind, dbKindWrite)
			}
		case "EXEC", "EXECUTE", "CALL":
			if i > 0 && d == dbSQLServer {
				kind = worse(kind, dbKindWrite)
				returnsRows = true
			}
		case "RETURNING", "OUTPUT":
			sawReturning = true
			if t.depth == 0 {
				returnsRows = true
			}
		case "SELECT":
			hasSelectVerb = true
		case "ANALYZE":
			// EXPLAIN ANALYZE really runs the statement; the DML scan covers writes.
		}
	}
	if (first == "WITH" || first == "SELECT") && dbKindRank[kind] >= dbKindRank[dbKindWrite] && !sawReturning {
		// WITH ... INSERT/UPDATE/DELETE, SELECT ... INTO: run with Exec to get
		// the affected row count.
		returnsRows = false
	}
	if d == dbSQLServer && hasSelectVerb && first != "INSERT" {
		returnsRows = true
	}
	if kind == dbKindOther && first == "" {
		reasons = appendOnce(reasons, "instrução não reconhecida")
	}
	st.Kind = kind
	st.ReturnsRows = returnsRows
	st.Reason = strings.Join(reasons, "; ")
	return st
}

func appendOnce(list []string, s string) []string {
	for _, v := range list {
		if v == s {
			return list
		}
	}
	return append(list, s)
}

// dmlHasWhere: after the UPDATE/DELETE at i, is there a WHERE at the same
// parenthesis depth before the statement ends?
func dmlHasWhere(ts []sqlTok, i int) bool {
	depth := ts[i].depth
	for j := i + 1; j < len(ts); j++ {
		t := ts[j]
		if t.depth < depth {
			return false
		}
		if t.depth != depth {
			continue
		}
		if t.kind == 'p' && t.text == ";" {
			return false
		}
		if t.kind == 'w' {
			if t.text == "WHERE" {
				return true
			}
			if dbStmtStarters[t.text] && j > i+1 && isDMLVerb(ts, j) {
				return false
			}
		}
	}
	return false
}

func pragmaKind(ts []sqlTok) dbStmtKind {
	name := ""
	for i := 1; i < len(ts); i++ {
		t := ts[i]
		if t.kind == 'p' && t.text == "=" {
			return dbKindSession
		}
		if t.kind == 'w' && name == "" {
			// "PRAGMA schema.name" — the last word before '(' or '=' is the name
			name = t.text
			if i+2 < len(ts) && ts[i+1].text == "." && ts[i+2].kind == 'w' {
				name = ts[i+2].text
				i += 2
			}
			if i+1 < len(ts) && ts[i+1].kind == 'p' && ts[i+1].text == "(" && !dbReadPragmas[name] {
				return dbKindSession
			}
		}
	}
	return dbKindRead
}

// dbConfirmSummary is what the page shows before running mutating statements.
type dbConfirmItem struct {
	Index  int        `json:"index"`
	SQL    string     `json:"sql"`
	Kind   dbStmtKind `json:"kind"`
	Danger bool       `json:"danger"`
	Reason string     `json:"reason,omitempty"`
}

func dbKindLabel(k dbStmtKind) string {
	switch k {
	case dbKindRead:
		return "leitura"
	case dbKindWrite:
		return "altera dados"
	case dbKindDDL:
		return "altera a estrutura"
	case dbKindTx:
		return "controle de transação"
	case dbKindSession:
		return "altera a sessão"
	}
	return "não reconhecida"
}
