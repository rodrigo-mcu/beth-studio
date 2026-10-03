package main

// db_dialect.go — per-driver details: opening a pool, quoting identifiers,
// placeholders, paging and the catalog queries behind the schema browser.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	mssql "github.com/microsoft/go-mssqldb"
	_ "modernc.org/sqlite"
)

const dbConnectTimeout = 10 * time.Second

// dbOpenPool opens a *sql.DB for c. database overrides c.Database ("" = keep).
func dbOpenPool(ctx context.Context, c DBConnConfig, password, database string) (*sql.DB, error) {
	if database != "" {
		c.Database = database
	}
	dialer, err := dbDialerFor(ctx, c)
	if err != nil {
		return nil, err
	}
	var db *sql.DB
	switch c.Driver {
	case dbPostgres:
		db, err = openPostgres(c, password, dialer)
	case dbMySQL:
		db, err = openMySQL(c, password, dialer)
	case dbSQLServer:
		db, err = openSQLServer(c, password, dialer)
	case dbSQLite:
		db, err = openSQLite(c)
	default:
		err = errors.New("tipo de banco inválido")
	}
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	db.SetConnMaxIdleTime(5 * time.Minute)
	if c.Driver == dbSQLite {
		db.SetMaxOpenConns(2)
	}
	return db, nil
}

func openPostgres(c DBConnConfig, password string, dialer DBDialer) (*sql.DB, error) {
	u := url.URL{Scheme: "postgres", Host: net.JoinHostPort(c.Host, strconv.Itoa(c.Port)), Path: "/" + c.Database}
	if password != "" {
		u.User = url.UserPassword(c.User, password)
	} else if c.User != "" {
		u.User = url.User(c.User)
	}
	q := url.Values{}
	q.Set("sslmode", c.SSLMode)
	q.Set("connect_timeout", strconv.Itoa(int(dbConnectTimeout/time.Second)))
	q.Set("application_name", "bethterm-web")
	u.RawQuery = q.Encode()
	cfg, err := pgx.ParseConfig(u.String())
	if err != nil {
		return nil, dbScrubErr(err, password)
	}
	// No server-side prepared statement cache: ad-hoc SQL and DDL changes
	// would otherwise hit "cached plan must not change result type".
	cfg.DefaultQueryExecMode = pgx.QueryExecModeExec
	if dialer != nil {
		cfg.DialFunc = dialer.DialContext
		cfg.LookupFunc = func(ctx context.Context, host string) ([]string, error) { return []string{host}, nil }
	}
	return stdlib.OpenDB(*cfg), nil
}

func openMySQL(c DBConnConfig, password string, dialer DBDialer) (*sql.DB, error) {
	cfg := mysql.NewConfig()
	cfg.User = c.User
	cfg.Passwd = password
	cfg.Net = "tcp"
	cfg.Addr = net.JoinHostPort(c.Host, strconv.Itoa(c.Port))
	cfg.DBName = c.Database
	cfg.Timeout = dbConnectTimeout
	cfg.ParseTime = true
	// Linhas afetadas = linhas encontradas (como Postgres e SQL Server). Sem
	// isto, gravar o mesmo valor numa linha conta 0 e a grade acha que a
	// chave não bateu.
	cfg.ClientFoundRows = true
	cfg.Loc = time.UTC
	cfg.MultiStatements = false
	cfg.Params = map[string]string{"charset": "utf8mb4"}
	switch c.SSLMode {
	case "disable":
		cfg.TLSConfig = "false"
	case "prefer":
		cfg.TLSConfig = "preferred"
	case "require":
		cfg.TLSConfig = "skip-verify"
	case "verify-full":
		cfg.TLSConfig = "true"
	}
	if dialer != nil {
		netName := "bethterm-db-" + c.ID
		mysql.RegisterDialContext(netName, func(ctx context.Context, addr string) (net.Conn, error) {
			return dialer.DialContext(ctx, "tcp", addr)
		})
		cfg.Net = netName
	}
	conn, err := mysql.NewConnector(cfg)
	if err != nil {
		return nil, dbScrubErr(err, password)
	}
	return sql.OpenDB(conn), nil
}

func openSQLServer(c DBConnConfig, password string, dialer DBDialer) (*sql.DB, error) {
	host, instance, _ := strings.Cut(c.Host, `\`)
	u := url.URL{Scheme: "sqlserver", Host: host}
	if instance != "" {
		u.Path = "/" + instance // the SQL Browser service resolves the port
	} else {
		u.Host = net.JoinHostPort(host, strconv.Itoa(c.Port))
	}
	if password != "" || c.User != "" {
		u.User = url.UserPassword(c.User, password)
	}
	q := url.Values{}
	if c.Database != "" {
		q.Set("database", c.Database)
	}
	q.Set("app name", "bethterm-web")
	q.Set("dial timeout", strconv.Itoa(int(dbConnectTimeout/time.Second)))
	switch c.SSLMode {
	case "disable":
		q.Set("encrypt", "disable")
	case "prefer":
		q.Set("encrypt", "false") // login packet only
	case "require":
		q.Set("encrypt", "true")
		q.Set("TrustServerCertificate", "true")
	case "verify-full":
		q.Set("encrypt", "true")
	}
	u.RawQuery = q.Encode()
	conn, err := mssql.NewConnector(u.String())
	if err != nil {
		return nil, dbScrubErr(err, password)
	}
	if dialer != nil {
		conn.Dialer = dialer
	}
	return sql.OpenDB(conn), nil
}

// dbSQLiteDSN builds a URI filename for modernc.org/sqlite.
func dbSQLiteDSN(c DBConnConfig) string {
	mode := "rw"
	if c.ReadOnly {
		mode = "ro"
	} else if c.CreateFile {
		mode = "rwc"
	}
	p := filepath.ToSlash(c.File)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p // file:///C:/dir/x.db
	}
	u := url.URL{Scheme: "file", Path: p}
	q := []string{"mode=" + mode, "_pragma=busy_timeout(5000)", "_pragma=foreign_keys(1)"}
	if c.ReadOnly {
		q = append(q, "_pragma=query_only(1)")
	}
	return "file://" + u.EscapedPath() + "?" + strings.Join(q, "&")
}

func openSQLite(c DBConnConfig) (*sql.DB, error) {
	if !c.CreateFile || c.ReadOnly {
		st, err := os.Stat(c.File)
		if err != nil {
			return nil, fmt.Errorf("arquivo não encontrado: %s", c.File)
		}
		if st.IsDir() {
			return nil, fmt.Errorf("o caminho é uma pasta, não um arquivo: %s", c.File)
		}
	}
	return sql.Open("sqlite", dbSQLiteDSN(c))
}

// dbScrubErr removes the password from an error message, just in case a
// driver echoes a DSN.
func dbScrubErr(err error, password string) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	if len(password) >= 3 && strings.Contains(msg, password) {
		msg = strings.ReplaceAll(msg, password, "••••")
		return errors.New(msg)
	}
	if len(password) >= 3 {
		if esc := url.QueryEscape(password); esc != password && strings.Contains(msg, esc) {
			return errors.New(strings.ReplaceAll(msg, esc, "••••"))
		}
	}
	return err
}

// dbQuoteIdent quotes one identifier for the driver.
func dbQuoteIdent(d dbDriver, name string) string {
	switch d {
	case dbMySQL:
		return "`" + strings.ReplaceAll(name, "`", "``") + "`"
	case dbSQLServer:
		return "[" + strings.ReplaceAll(name, "]", "]]") + "]"
	default:
		return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
	}
}

// dbQualified is schema.table (schema may be empty).
func dbQualified(d dbDriver, schema, table string) string {
	if schema == "" {
		return dbQuoteIdent(d, table)
	}
	return dbQuoteIdent(d, schema) + "." + dbQuoteIdent(d, table)
}

// dbPlaceholder returns the n-th (1-based) bind parameter marker.
func dbPlaceholder(d dbDriver, n int) string {
	switch d {
	case dbPostgres:
		return "$" + strconv.Itoa(n)
	case dbSQLServer:
		return "@p" + strconv.Itoa(n)
	default:
		return "?"
	}
}

// dbVersionQuery returns the server/library version.
func dbVersionQuery(d dbDriver) string {
	switch d {
	case dbPostgres:
		return "SELECT version()"
	case dbMySQL:
		return "SELECT CONCAT(@@version_comment, ' ', VERSION())"
	case dbSQLServer:
		return "SELECT @@VERSION"
	default:
		return "SELECT 'SQLite ' || sqlite_version()"
	}
}

// dbTextCast casts a column to text for "contains"/"starts with" filters.
func dbTextCast(d dbDriver, col string) string {
	switch d {
	case dbMySQL:
		return "CAST(" + col + " AS CHAR)"
	case dbSQLServer:
		return "CAST(" + col + " AS NVARCHAR(MAX))"
	default:
		return "CAST(" + col + " AS TEXT)"
	}
}

// --- catalog ---

type dbObject struct {
	Name         string `json:"name"`
	Type         string `json:"type"` // table | view
	RowsEstimate *int64 `json:"rows_estimate,omitempty"`
}

type dbColumn struct {
	Name     string  `json:"name"`
	Type     string  `json:"type"`
	Nullable bool    `json:"nullable"`
	Default  *string `json:"default,omitempty"`
	PK       bool    `json:"pk"`
}

type dbIndex struct {
	Name    string   `json:"name"`
	Columns []string `json:"columns"`
	Unique  bool     `json:"unique"`
	Primary bool     `json:"primary"`
}

func dbQueryStrings(ctx context.Context, q queryer, query string, args ...any) ([]string, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s sql.NullString
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s.String)
	}
	return out, rows.Err()
}

type queryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// dbListDatabases: databases the tree can switch to (PostgreSQL, SQL Server).
func dbListDatabases(ctx context.Context, d dbDriver, q queryer) ([]string, string, error) {
	var list []string
	var cur []string
	var err error
	switch d {
	case dbPostgres:
		list, err = dbQueryStrings(ctx, q, "SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn AND has_database_privilege(datname, 'CONNECT') ORDER BY 1")
		if err == nil {
			cur, err = dbQueryStrings(ctx, q, "SELECT current_database()")
		}
	case dbSQLServer:
		list, err = dbQueryStrings(ctx, q, "SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY name")
		if err == nil {
			cur, err = dbQueryStrings(ctx, q, "SELECT DB_NAME()")
		}
	default:
		return nil, "", nil
	}
	if err != nil {
		return nil, "", err
	}
	c := ""
	if len(cur) > 0 {
		c = cur[0]
	}
	return list, c, nil
}

// dbListSchemas: schemas (MySQL: databases; SQLite: attached databases).
func dbListSchemas(ctx context.Context, d dbDriver, q queryer, system bool) ([]string, string, error) {
	var list, cur []string
	var err error
	switch d {
	case dbPostgres:
		qs := "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp%'"
		if !system {
			qs += " AND nspname NOT IN ('pg_catalog','information_schema')"
		}
		list, err = dbQueryStrings(ctx, q, qs+" ORDER BY 1")
		if err == nil {
			cur, err = dbQueryStrings(ctx, q, "SELECT current_schema()")
		}
	case dbMySQL:
		qs := "SELECT schema_name FROM information_schema.schemata"
		if !system {
			qs += " WHERE schema_name NOT IN ('information_schema','mysql','performance_schema','sys')"
		}
		list, err = dbQueryStrings(ctx, q, qs+" ORDER BY 1")
		if err == nil {
			cur, err = dbQueryStrings(ctx, q, "SELECT DATABASE()")
		}
	case dbSQLServer:
		qs := "SELECT name FROM sys.schemas WHERE schema_id < 16384"
		if !system {
			qs += " AND name NOT IN ('sys','INFORMATION_SCHEMA','guest')"
		}
		list, err = dbQueryStrings(ctx, q, qs+" ORDER BY name")
		if err == nil {
			cur, err = dbQueryStrings(ctx, q, "SELECT SCHEMA_NAME()")
		}
	case dbSQLite:
		var rows *sql.Rows
		rows, err = q.QueryContext(ctx, "SELECT name FROM pragma_database_list ORDER BY seq")
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var n string
				if err = rows.Scan(&n); err != nil {
					break
				}
				if n != "temp" || system {
					list = append(list, n)
				}
			}
			if err == nil {
				err = rows.Err()
			}
		}
		cur = []string{"main"}
	}
	if err != nil {
		return nil, "", err
	}
	c := ""
	if len(cur) > 0 {
		c = cur[0]
	}
	return list, c, nil
}

func nullInt(v sql.NullInt64) *int64 {
	if !v.Valid || v.Int64 < 0 {
		return nil
	}
	x := v.Int64
	return &x
}

// dbListObjects: tables and views of a schema, with a row estimate.
func dbListObjects(ctx context.Context, d dbDriver, q queryer, schema string) ([]dbObject, error) {
	var query string
	var args []any
	switch d {
	case dbPostgres:
		query = `SELECT c.relname,
  CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' ELSE 'table' END,
  CASE WHEN c.relkind IN ('r','p') THEN c.reltuples::bigint END
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f')
ORDER BY 1`
		args = []any{schema}
	case dbMySQL:
		query = `SELECT table_name, CASE WHEN table_type LIKE '%VIEW' THEN 'view' ELSE 'table' END, table_rows
FROM information_schema.tables WHERE table_schema = ? ORDER BY 1`
		args = []any{schema}
	case dbSQLServer:
		query = `SELECT o.name, CASE WHEN o.type = 'V' THEN 'view' ELSE 'table' END,
  (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0,1))
FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE s.name = @p1 AND o.type IN ('U','V')
ORDER BY o.name`
		args = []any{schema}
	case dbSQLite:
		query = `SELECT name, type, NULL FROM ` + dbQuoteIdent(d, schema) + `.sqlite_master
WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\_%' ESCAPE '\' ORDER BY name`
	}
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []dbObject
	for rows.Next() {
		var o dbObject
		var est sql.NullInt64
		if err := rows.Scan(&o.Name, &o.Type, &est); err != nil {
			return nil, err
		}
		o.RowsEstimate = nullInt(est)
		out = append(out, o)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if d == dbSQLite {
		sqliteRowEstimates(ctx, q, schema, out)
	}
	return out, nil
}

// sqliteRowEstimates fills estimates from sqlite_stat1 (only present after
// ANALYZE); silently does nothing otherwise.
func sqliteRowEstimates(ctx context.Context, q queryer, schema string, objs []dbObject) {
	rows, err := q.QueryContext(ctx, `SELECT tbl, stat FROM `+dbQuoteIdent(dbSQLite, schema)+`.sqlite_stat1`)
	if err != nil {
		return
	}
	defer rows.Close()
	best := map[string]int64{}
	for rows.Next() {
		var tbl, stat sql.NullString
		if rows.Scan(&tbl, &stat) != nil {
			return
		}
		f := strings.Fields(stat.String)
		if len(f) == 0 {
			continue
		}
		if n, err := strconv.ParseInt(f[0], 10, 64); err == nil && n > best[tbl.String] {
			best[tbl.String] = n
		}
	}
	for i := range objs {
		if n, ok := best[objs[i].Name]; ok && objs[i].Type == "table" {
			v := n
			objs[i].RowsEstimate = &v
		}
	}
}

type dbRoutine struct {
	Name string `json:"name"`
	Args string `json:"args"`
	Kind string `json:"kind"` // function | procedure
}

// dbListRoutines lists functions and procedures of a schema. SQLite has none.
func dbListRoutines(ctx context.Context, d dbDriver, q queryer, schema string) ([]dbRoutine, error) {
	var query string
	var args []any
	switch d {
	case dbPostgres:
		query = `SELECT p.proname,
  CASE WHEN p.prokind = 'p' THEN 'procedure' ELSE 'function' END,
  pg_get_function_identity_arguments(p.oid)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = $1 AND p.prokind IN ('f','p')
ORDER BY 1, 3`
		args = []any{schema}
	case dbMySQL:
		query = `SELECT r.routine_name,
  CASE WHEN r.routine_type = 'PROCEDURE' THEN 'procedure' ELSE 'function' END,
  (SELECT GROUP_CONCAT(CONCAT(IFNULL(p.parameter_name, ''), ' ', p.dtd_identifier) ORDER BY p.ordinal_position SEPARATOR ', ')
   FROM information_schema.parameters p
   WHERE p.specific_schema = r.routine_schema AND p.specific_name = r.specific_name AND p.ordinal_position > 0)
FROM information_schema.routines r
WHERE r.routine_schema = ?
ORDER BY r.routine_name`
		args = []any{schema}
	case dbSQLServer:
		query = `SELECT o.name,
  CASE WHEN o.type = 'P' THEN 'procedure' ELSE 'function' END,
  ISNULL(STUFF((
    SELECT ', ' + p.name + ' ' + TYPE_NAME(p.user_type_id)
    FROM sys.parameters p
    WHERE p.object_id = o.object_id AND p.parameter_id > 0
    ORDER BY p.parameter_id
    FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, ''), '')
FROM sys.objects o
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE s.name = @p1 AND o.type IN ('FN','IF','TF','P','FS','FT')
ORDER BY o.name`
		args = []any{schema}
	default:
		return []dbRoutine{}, nil
	}
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []dbRoutine
	for rows.Next() {
		var r dbRoutine
		var args sql.NullString
		if err := rows.Scan(&r.Name, &r.Kind, &args); err != nil {
			return nil, err
		}
		if args.Valid {
			r.Args = strings.TrimSpace(args.String)
		}
		out = append(out, r)
	}
	if out == nil {
		out = []dbRoutine{}
	}
	return out, rows.Err()
}

// dbListColumns returns the columns of a table or view.
func dbListColumns(ctx context.Context, d dbDriver, q queryer, schema, table string) ([]dbColumn, error) {
	var query string
	args := []any{schema, table}
	switch d {
	case dbPostgres:
		query = `SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
  pg_get_expr(ad.adbin, ad.adrelid),
  EXISTS (SELECT 1 FROM pg_index ix WHERE ix.indrelid = c.oid AND ix.indisprimary AND a.attnum = ANY(ix.indkey))
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum`
	case dbMySQL:
		query = `SELECT column_name, column_type, is_nullable = 'YES', column_default, column_key = 'PRI'
FROM information_schema.columns WHERE table_schema = ? AND table_name = ?
ORDER BY ordinal_position`
	case dbSQLServer:
		query = `SELECT c.name,
  TYPE_NAME(c.user_type_id) +
  CASE
    WHEN TYPE_NAME(c.user_type_id) IN ('varchar','char','varbinary','binary')
      THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar(10)) END + ')'
    WHEN TYPE_NAME(c.user_type_id) IN ('nvarchar','nchar')
      THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')'
    WHEN TYPE_NAME(c.user_type_id) IN ('decimal','numeric')
      THEN '(' + CAST(c.precision AS varchar(5)) + ',' + CAST(c.scale AS varchar(5)) + ')'
    ELSE '' END,
  c.is_nullable,
  OBJECT_DEFINITION(c.default_object_id),
  CAST(CASE WHEN EXISTS (
    SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
    WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END AS bit)
FROM sys.columns c
JOIN sys.objects o ON o.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE s.name = @p1 AND o.name = @p2
ORDER BY c.column_id`
	case dbSQLite:
		query = `SELECT name, type, "notnull" = 0, dflt_value, pk > 0 FROM pragma_table_info(?, ?) ORDER BY cid`
		args = []any{table, schema}
	}
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []dbColumn
	for rows.Next() {
		var c dbColumn
		var def sql.NullString
		var nullable, pk any
		if err := rows.Scan(&c.Name, &c.Type, &nullable, &def, &pk); err != nil {
			return nil, err
		}
		c.Nullable = dbTruthy(nullable)
		c.PK = dbTruthy(pk)
		if def.Valid {
			v := def.String
			c.Default = &v
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// dbTruthy reads booleans that drivers return as bool, int or "1"/"0" bytes.
func dbTruthy(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case int64:
		return x != 0
	case int32:
		return x != 0
	case int:
		return x != 0
	case float64:
		return x != 0
	case []byte:
		s := strings.ToLower(string(x))
		return s == "1" || s == "t" || s == "true"
	case string:
		s := strings.ToLower(x)
		return s == "1" || s == "t" || s == "true"
	}
	return false
}

// dbListIndexes returns the indexes of a table.
func dbListIndexes(ctx context.Context, d dbDriver, q queryer, schema, table string) ([]dbIndex, error) {
	var out []dbIndex
	scanList := func(query string, args ...any) error {
		rows, err := q.QueryContext(ctx, query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var ix dbIndex
			var uniq, prim any
			var cols sql.NullString
			if err := rows.Scan(&ix.Name, &uniq, &prim, &cols); err != nil {
				return err
			}
			ix.Unique, ix.Primary = dbTruthy(uniq), dbTruthy(prim)
			if cols.String != "" {
				ix.Columns = strings.Split(cols.String, ",")
			}
			out = append(out, ix)
		}
		return rows.Err()
	}
	var err error
	switch d {
	case dbPostgres:
		err = scanList(`SELECT i.relname, ix.indisunique, ix.indisprimary,
  array_to_string(ARRAY(
    SELECT a.attname FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    ORDER BY k.ord), ',')
FROM pg_index ix
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_class t ON t.oid = ix.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = $1 AND t.relname = $2
ORDER BY 1`, schema, table)
	case dbMySQL:
		err = scanList(`SELECT index_name, MIN(non_unique) = 0, index_name = 'PRIMARY',
  GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',')
FROM information_schema.statistics WHERE table_schema = ? AND table_name = ?
GROUP BY index_name ORDER BY index_name`, schema, table)
	case dbSQLServer:
		err = scanList(`SELECT i.name, i.is_unique, i.is_primary_key,
  STUFF((SELECT ',' + col.name FROM sys.index_columns ic
         JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
         WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
         ORDER BY ic.key_ordinal FOR XML PATH('')), 1, 1, '')
FROM sys.indexes i
JOIN sys.objects o ON o.object_id = i.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE s.name = @p1 AND o.name = @p2 AND i.name IS NOT NULL
ORDER BY i.name`, schema, table)
	case dbSQLite:
		var names []dbIndex
		rows, qerr := q.QueryContext(ctx, `SELECT name, "unique", origin = 'pk' FROM pragma_index_list(?, ?) ORDER BY name`, table, schema)
		if qerr != nil {
			return nil, qerr
		}
		for rows.Next() {
			var ix dbIndex
			var uniq, prim any
			if err := rows.Scan(&ix.Name, &uniq, &prim); err != nil {
				rows.Close()
				return nil, err
			}
			ix.Unique, ix.Primary = dbTruthy(uniq), dbTruthy(prim)
			names = append(names, ix)
		}
		rows.Close()
		for _, ix := range names {
			cols, cerr := dbQueryStrings(ctx, q, `SELECT name FROM pragma_index_info(?, ?) ORDER BY seqno`, ix.Name, schema)
			if cerr != nil {
				return nil, cerr
			}
			ix.Columns = cols
			out = append(out, ix)
		}
	}
	return out, err
}
