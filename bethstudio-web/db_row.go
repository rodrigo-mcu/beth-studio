package main

// Edição de uma célula. Só quando a linha tem chave primária: o UPDATE
// usa essa chave no WHERE e altera uma coluna. Valores vão como
// parâmetros. Sem chave, ou com JOIN, a grade não edita.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

func (s *server) dbUpdateRow(w http.ResponseWriter, r *http.Request, body []byte) {
	var req struct {
		ID       string                     `json:"id"`
		Database string                     `json:"database"`
		Schema   string                     `json:"schema"`
		Table    string                     `json:"table"`
		Column   string                     `json:"column"`
		Value    json.RawMessage            `json:"value"`
		Null     bool                       `json:"null"`
		Where    map[string]json.RawMessage `json:"where"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		dbFail(w, http.StatusBadRequest, errors.New("requisição inválida"))
		return
	}
	if s.dbAppReadOnly() {
		dbFail(w, http.StatusForbidden, errors.New("o Beth Studio foi aberto em modo somente leitura"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dbBrowseTimeout)
	defer cancel()
	t, err := s.dbResolve(ctx, req.ID, req.Database)
	if err != nil {
		dbFail(w, http.StatusBadRequest, err)
		return
	}
	if t.cfg.ReadOnly {
		dbFail(w, http.StatusForbidden, errors.New("esta conexão é somente leitura"))
		return
	}
	db, err := dbPools.get(ctx, t.cfg, t.password, t.database)
	if err != nil {
		dbFail(w, http.StatusBadGateway, dbScrubErr(err, t.password))
		return
	}
	n, err := dbExecUpdate(ctx, db, t.cfg.Driver, t.database, req.Schema, req.Table, req.Column, req.Null, req.Value, req.Where)
	if err != nil {
		dbFail(w, http.StatusBadRequest, dbScrubErr(err, t.password))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "affected": n})
}

func dbExecUpdate(ctx context.Context, db *sql.DB, d dbDriver, database, schema, table, column string, isNull bool, raw json.RawMessage, where map[string]json.RawMessage) (int64, error) {
	if schema == "" {
		schema = dbCurrentSchema(ctx, db, d, database)
	}
	cols, err := dbListColumns(ctx, d, db, schema, table)
	if err != nil {
		return 0, err
	}
	if len(cols) == 0 {
		return 0, errors.New("tabela não encontrada")
	}
	byName := map[string]dbColumn{}
	var pk []string
	for _, c := range cols {
		byName[c.Name] = c
		if c.PK {
			pk = append(pk, c.Name)
		}
	}
	if len(pk) == 0 {
		return 0, errors.New("esta tabela não tem chave primária")
	}
	col, ok := byName[column]
	if !ok {
		return 0, fmt.Errorf("coluna desconhecida: %s", column)
	}
	if dbLooksBinaryType(col.Type) {
		return 0, errors.New("coluna binária não é editada na grade")
	}
	for _, p := range pk {
		if _, ok := where[p]; !ok {
			return 0, errors.New("falta a chave primária da linha")
		}
	}
	var setVal any
	if isNull {
		if !col.Nullable {
			return 0, errors.New("esta coluna não aceita NULL")
		}
		setVal = nil
	} else {
		v, err := dbDecodeCell(raw)
		if err != nil {
			return 0, err
		}
		setVal, err = dbCoerceCell(d, col.Type, v)
		if err != nil {
			return 0, err
		}
	}
	args := []any{setVal}
	var wh []string
	for _, p := range pk {
		pv, err := dbDecodeCell(where[p])
		if err != nil {
			return 0, err
		}
		pv, err = dbCoerceCell(d, byName[p].Type, pv)
		if err != nil {
			return 0, err
		}
		args = append(args, pv)
		wh = append(wh, dbQuoteIdent(d, p)+" = "+dbPlaceholder(d, len(args)))
	}
	q := fmt.Sprintf("UPDATE %s SET %s = %s WHERE %s",
		dbQualified(d, schema, table), dbQuoteIdent(d, column), dbPlaceholder(d, 1), strings.Join(wh, " AND "))
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	res, err := tx.ExecContext(ctx, q, args...)
	if err != nil {
		_ = tx.Rollback()
		return 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		_ = tx.Rollback()
		return 0, err
	}
	if n != 1 {
		_ = tx.Rollback()
		if n == 0 {
			return 0, errors.New("nenhuma linha atualizada: o registro mudou ou a chave não confere")
		}
		return 0, fmt.Errorf("a chave atingiria %d linhas; a alteração foi desfeita", n)
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return n, nil
}

func dbAnnotateEdits(ctx context.Context, db *sql.DB, d dbDriver, database string, stmts []dbStatement, results []dbResult) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	for i := range results {
		res := &results[i]
		if len(res.Columns) == 0 || res.Statement < 0 || res.Statement >= len(stmts) {
			continue
		}
		res.Edit = dbLookupEdit(ctx, db, d, database, stmts[res.Statement].SQL, res.Columns)
	}
}

func dbLookupEdit(ctx context.Context, q queryer, d dbDriver, database, sql string, resultCols []dbResultColumn) *dbEditInfo {
	schema, table, ok := dbSimpleSelectTable(d, sql)
	if !ok {
		return nil
	}
	if schema == "" {
		schema = dbCurrentSchema(ctx, q, d, database)
	}
	if schema == "" {
		return nil
	}
	list, err := dbListColumns(ctx, d, q, schema, table)
	if err != nil || len(list) == 0 {
		return nil
	}
	var pk, names []string
	for _, c := range list {
		names = append(names, c.Name)
		if c.PK {
			pk = append(pk, c.Name)
		}
	}
	if len(pk) == 0 {
		return nil
	}
	have := map[string]int{}
	for _, c := range resultCols {
		have[c.Name]++
	}
	for _, p := range pk {
		if have[p] != 1 {
			return nil
		}
	}
	// De onde vem cada coluna do resultado: só coluna da tabela, sem
	// expressão nem apelido trocado, pode ser editada ou servir de chave.
	// "SELECT nome AS id" ou "SELECT max(id) AS id" gravariam na linha errada.
	sel, ok := dbSelectSources(d, sql)
	if !ok {
		return nil
	}
	direct := func(name string) bool {
		if src, ok := sel.plain[dbFold(d, name)]; ok {
			return src == dbFold(d, name)
		}
		if sel.computed[dbFold(d, name)] {
			return false
		}
		return sel.star
	}
	for _, p := range pk {
		if !direct(p) {
			return nil
		}
	}
	var editable []string
	for _, n := range names {
		if have[n] == 1 && direct(n) {
			editable = append(editable, n)
		}
	}
	return &dbEditInfo{Schema: schema, Table: table, PK: pk, Columns: editable}
}

// dbFold: como o banco compara nomes de coluna sem aspas.
func dbFold(d dbDriver, s string) string {
	if d == dbPostgres {
		return s // os nomes já vêm como o Postgres guardou (dbIdentOf)
	}
	return strings.ToLower(s)
}

type dbSelectList struct {
	star     bool              // "*" ou "t.*"
	plain    map[string]string // nome no resultado -> coluna de origem (só "col" ou "t.col")
	computed map[string]bool   // nome no resultado vindo de expressão
}

// dbSelectSources lê a lista do SELECT (até o FROM, fora de parênteses).
// ok=false com DISTINCT, agregação sem nome conhecido etc. não importa: o
// que não é coluna direta só deixa de ser editável.
func dbSelectSources(d dbDriver, sql string) (dbSelectList, bool) {
	out := dbSelectList{plain: map[string]string{}, computed: map[string]bool{}}
	ts := trimSemis(dbLex(d, sql))
	if len(ts) == 0 || ts[0].kind != 'w' || ts[0].text != "SELECT" {
		return out, false
	}
	i := 1
	// SELECT DISTINCT junta linhas iguais: a chave ainda separa, mas
	// DISTINCT ON (Postgres) escolhe uma linha por grupo; fica de fora.
	for i < len(ts) && ts[i].kind == 'w' && (ts[i].text == "ALL" || ts[i].text == "DISTINCT") {
		if ts[i].text == "DISTINCT" && i+1 < len(ts) && ts[i+1].kind == 'w' && ts[i+1].text == "ON" {
			return out, false
		}
		i++
	}
	// SQL Server: TOP n / TOP (n) [PERCENT] [WITH TIES]
	if d == dbSQLServer && i < len(ts) && ts[i].kind == 'w' && ts[i].text == "TOP" {
		i++
		for i < len(ts) && (ts[i].depth > 0 || ts[i].kind == 'n' || (ts[i].kind == 'p' && (ts[i].text == "(" || ts[i].text == ")"))) {
			i++
		}
		for i < len(ts) && ts[i].kind == 'w' && (ts[i].text == "PERCENT" || ts[i].text == "WITH" || ts[i].text == "TIES") {
			i++
		}
	}
	var item []sqlTok
	flush := func() bool {
		defer func() { item = nil }()
		if len(item) == 0 {
			return false
		}
		return dbSelectItem(d, sql, item, &out)
	}
	for ; i < len(ts); i++ {
		t := ts[i]
		if t.depth == 0 && t.kind == 'w' && t.text == "FROM" {
			if !flush() {
				return out, false
			}
			return out, true
		}
		if t.depth == 0 && t.kind == 'p' && t.text == "," {
			if !flush() {
				return out, false
			}
			continue
		}
		item = append(item, t)
	}
	return out, false
}

func dbIsName(t sqlTok) bool { return t.kind == 'w' || t.kind == 'q' }

// dbSelectItem classifica um item: "*", "t.*", "col", "t.col", "s.t.col",
// cada um com [AS] apelido opcional. O resto é expressão.
func dbSelectItem(d dbDriver, sql string, it []sqlTok, out *dbSelectList) bool {
	last := it[len(it)-1]
	if last.kind == 'p' && last.text == "*" {
		out.star = true
		return true
	}
	// apelido: "... AS x" ou "... x" depois de um nome/parêntese
	body, alias := it, ""
	if len(it) >= 2 && dbIsName(last) {
		prev := it[len(it)-2]
		if prev.kind == 'w' && prev.text == "AS" {
			a, _ := dbIdentOf(d, sql, last)
			body, alias = it[:len(it)-2], a
		} else if dbIsName(prev) || (prev.kind == 'p' && prev.text == ")") {
			a, _ := dbIdentOf(d, sql, last)
			body, alias = it[:len(it)-1], a
		}
	}
	// coluna direta: nome ( "." nome ){0,2}
	plain := len(body)%2 == 1 && len(body) <= 5
	for k, t := range body {
		if k%2 == 0 && !dbIsName(t) {
			plain = false
		}
		if k%2 == 1 && !(t.kind == 'p' && t.text == ".") {
			plain = false
		}
	}
	if plain {
		col, _ := dbIdentOf(d, sql, body[len(body)-1])
		name := col
		if alias != "" {
			name = alias
		}
		out.plain[dbFold(d, name)] = dbFold(d, col)
		return true
	}
	if alias != "" {
		out.computed[dbFold(d, alias)] = true
	}
	// expressão sem apelido: o banco inventa o nome ("max", "?column?",
	// "max(id)"); não coincide com uma coluna da tabela por acaso
	return true
}

func dbCurrentSchema(ctx context.Context, q queryer, d dbDriver, database string) string {
	switch d {
	case dbSQLite:
		return "main"
	case dbMySQL:
		if database != "" {
			return database
		}
		if rows, err := dbQueryStrings(ctx, q, "SELECT DATABASE()"); err == nil && len(rows) > 0 && rows[0] != "" {
			return rows[0]
		}
	case dbSQLServer:
		if rows, err := dbQueryStrings(ctx, q, "SELECT SCHEMA_NAME()"); err == nil && len(rows) > 0 && rows[0] != "" {
			return rows[0]
		}
		return "dbo"
	default:
		if rows, err := dbQueryStrings(ctx, q, "SELECT current_schema()"); err == nil && len(rows) > 0 && rows[0] != "" {
			return rows[0]
		}
		return "public"
	}
	return ""
}

// dbSimpleSelectTable accepts SELECT ... FROM schema.table [alias] [WHERE|ORDER|LIMIT|OFFSET|FETCH].
// JOIN, UNION and GROUP are refused.
func dbSimpleSelectTable(d dbDriver, sql string) (schema, table string, ok bool) {
	ts := trimSemis(dbLex(d, sql))
	if len(ts) == 0 || ts[0].kind != 'w' || ts[0].text != "SELECT" {
		return "", "", false
	}
	from := -1
	for i, t := range ts {
		if t.depth != 0 || t.kind != 'w' {
			continue
		}
		switch t.text {
		case "JOIN", "UNION", "INTERSECT", "EXCEPT", "INTO", "GROUP", "WINDOW", "PIVOT", "UNPIVOT":
			return "", "", false
		case "FROM":
			if from >= 0 {
				return "", "", false
			}
			from = i
		}
	}
	if from < 0 {
		return "", "", false
	}
	schema, table, next, ok := dbReadQualName(d, sql, ts, from+1)
	if !ok {
		return "", "", false
	}
	if next < len(ts) {
		t := ts[next]
		if t.depth == 0 && t.kind == 'w' && t.text == "AS" {
			next += 2
		} else if t.depth == 0 && (t.kind == 'w' || t.kind == 'q') && !dbAfterTableClause(t.text) {
			next++
		}
	}
	if next < len(ts) {
		t := ts[next]
		if t.depth != 0 || t.kind != 'w' || !dbAfterTableClause(t.text) {
			return "", "", false
		}
	}
	if table == "" {
		return "", "", false
	}
	return schema, table, true
}

func dbAfterTableClause(w string) bool {
	switch w {
	case "WHERE", "ORDER", "LIMIT", "OFFSET", "FETCH":
		return true
	default:
		return false
	}
}

func dbReadQualName(d dbDriver, sql string, ts []sqlTok, i int) (schema, table string, next int, ok bool) {
	if i >= len(ts) {
		return "", "", i, false
	}
	a, ok := dbIdentOf(d, sql, ts[i])
	if !ok || a == "" {
		return "", "", i, false
	}
	if i+2 < len(ts) && ts[i+1].kind == 'p' && ts[i+1].text == "." {
		b, ok := dbIdentOf(d, sql, ts[i+2])
		if !ok || b == "" {
			return "", "", i, false
		}
		return a, b, i + 3, true
	}
	return "", a, i + 1, true
}

func dbIdentOf(d dbDriver, sql string, t sqlTok) (string, bool) {
	if t.start < 0 || t.end > len(sql) || t.end < t.start {
		return "", false
	}
	raw := sql[t.start:t.end]
	switch t.kind {
	case 'w':
		if d == dbPostgres {
			return strings.ToLower(raw), true
		}
		return raw, true
	case 'q':
		return dbUnquoteIdent(raw), true
	default:
		return "", false
	}
}

func dbUnquoteIdent(raw string) string {
	if len(raw) < 2 {
		return raw
	}
	switch raw[0] {
	case '"', '`':
		body := raw[1 : len(raw)-1]
		return strings.ReplaceAll(body, raw[:1]+raw[:1], raw[:1])
	case '[':
		if raw[len(raw)-1] != ']' {
			return raw
		}
		return strings.ReplaceAll(raw[1:len(raw)-1], "]]", "]")
	default:
		return raw
	}
}

func dbDecodeCell(raw json.RawMessage) (any, error) {
	s := strings.TrimSpace(string(raw))
	if s == "" || s == "null" {
		return nil, nil
	}
	if s[0] == '"' {
		var out string
		if err := json.Unmarshal(raw, &out); err != nil {
			return nil, errors.New("valor inválido")
		}
		if utf8.RuneCountInString(out) > 1<<20 {
			return nil, errors.New("valor longo demais")
		}
		return out, nil
	}
	if s == "true" {
		return true, nil
	}
	if s == "false" {
		return false, nil
	}
	if i, err := strconv.ParseInt(s, 10, 64); err == nil {
		return i, nil
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil && !math.IsNaN(f) && !math.IsInf(f, 0) {
		return f, nil
	}
	return nil, errors.New("valor inválido")
}

// dbDecimalRe: número exato como texto (DECIMAL/NUMERIC/MONEY).
var dbDecimalRe = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)

// dbMySQLTimeRe: "2026-09-30T12:34:56.123456Z" (como a grade mostra) ->
// o MySQL estrito recusa o "T" e o fuso; vai "2026-09-30 12:34:56.123456".
var dbMySQLTimeRe = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d{1,6})?\d*(Z|[+-]\d{2}:\d{2})$`)

func dbCoerceCell(d dbDriver, colType string, v any) (any, error) {
	if v == nil {
		return nil, nil
	}
	t := strings.ToUpper(colType)
	// DECIMAL/NUMERIC/MONEY vão como texto: float64 arredonda valores com
	// mais de 15 dígitos (e centavos de valores altos). O banco converte.
	exact := strings.Contains(t, "DECIMAL") || strings.Contains(t, "NUMERIC") || strings.Contains(t, "MONEY")
	if exact {
		var txt string
		switch x := v.(type) {
		case string:
			txt = strings.TrimSpace(x)
		case int64:
			txt = strconv.FormatInt(x, 10)
		case float64:
			txt = strconv.FormatFloat(x, 'f', -1, 64)
		}
		if !dbDecimalRe.MatchString(txt) {
			return nil, fmt.Errorf("valor numérico inválido para %s: %v", colType, v)
		}
		return txt, nil
	}
	if d == dbMySQL && (strings.Contains(t, "DATE") || strings.Contains(t, "TIME")) {
		if x, ok := v.(string); ok {
			if m := dbMySQLTimeRe.FindStringSubmatch(strings.TrimSpace(x)); m != nil {
				return m[1] + " " + m[2] + m[3], nil
			}
		}
	}
	intLike := strings.Contains(t, "INT") || strings.Contains(t, "SERIAL")
	floatLike := strings.Contains(t, "FLOAT") || strings.Contains(t, "DOUBLE") || strings.Contains(t, "REAL")
	boolLike := strings.Contains(t, "BOOL") || t == "BIT"
	if boolLike {
		switch x := v.(type) {
		case bool:
			return x, nil
		case int64:
			return x != 0, nil
		case string:
			switch strings.ToLower(strings.TrimSpace(x)) {
			case "true", "1", "t", "yes", "sim":
				return true, nil
			case "false", "0", "f", "no", "não", "nao":
				return false, nil
			}
		}
	}
	if intLike {
		switch x := v.(type) {
		case int64:
			return x, nil
		case float64:
			if x == math.Trunc(x) && x >= math.MinInt64 && x <= math.MaxInt64 {
				return int64(x), nil
			}
		case string:
			if i, err := strconv.ParseInt(strings.TrimSpace(x), 10, 64); err == nil {
				return i, nil
			}
		}
	}
	if floatLike {
		switch x := v.(type) {
		case float64:
			return x, nil
		case int64:
			return float64(x), nil
		case string:
			if f, err := strconv.ParseFloat(strings.TrimSpace(x), 64); err == nil {
				return f, nil
			}
		}
	}
	switch x := v.(type) {
	case string:
		return x, nil
	case int64:
		return strconv.FormatInt(x, 10), nil
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64), nil
	case bool:
		if x {
			return "true", nil
		}
		return "false", nil
	default:
		return nil, errors.New("valor inválido")
	}
}
