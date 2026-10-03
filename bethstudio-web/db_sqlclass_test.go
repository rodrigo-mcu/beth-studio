package main

import (
	"testing"
)

func TestDBSplitStatements(t *testing.T) {
	cases := []struct {
		d    dbDriver
		in   string
		want []string
	}{
		{dbSQLite, "select 1; select 2;", []string{"select 1", "select 2"}},
		{dbSQLite, "select ';' as a; -- comment ; here\nselect 2", []string{"select ';' as a", "select 2"}},
		{dbSQLite, "/* only a comment; */ ;; ", nil},
		{dbPostgres, "select $$a;b$$; select $tag$x;y$tag$;", []string{"select $$a;b$$", "select $tag$x;y$tag$"}},
		{dbPostgres, "select $1; select 2", []string{"select $1", "select 2"}},
		{dbPostgres, "select E'it\\'s;' ; select 3", []string{"select E'it\\'s;'", "select 3"}},
		{dbPostgres, "/* outer /* inner; */ still; */ select 1; select 2", []string{"select 1", "select 2"}},
		{dbMySQL, "select 'a\\';b'; # hash; comment\nselect `x;y` from t", []string{"select 'a\\';b'", "select `x;y` from t"}},
		{dbSQLite, "CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE u SET n = n + 1; INSERT INTO log VALUES (1); END; SELECT 1",
			[]string{"CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE u SET n = n + 1; INSERT INTO log VALUES (1); END", "SELECT 1"}},
		{dbMySQL, "CREATE PROCEDURE p() BEGIN IF 1 THEN SELECT 1; END IF; SELECT 2; END; CALL p()",
			[]string{"CREATE PROCEDURE p() BEGIN IF 1 THEN SELECT 1; END IF; SELECT 2; END", "CALL p()"}},
		{dbSQLServer, "SELECT 1; SELECT 2\nGO\nSELECT [a;b] FROM t\n  go  \n", []string{"SELECT 1; SELECT 2", "SELECT [a;b] FROM t"}},
		{dbSQLServer, "SELECT go FROM t", []string{"SELECT go FROM t"}},
	}
	for _, c := range cases {
		got := dbSplitStatements(c.d, c.in)
		if len(got) != len(c.want) {
			t.Errorf("%s %q: got %d statements %+v, want %d", c.d, c.in, len(got), got, len(c.want))
			continue
		}
		for i := range got {
			if got[i].SQL != c.want[i] {
				t.Errorf("%s %q [%d]: got %q, want %q", c.d, c.in, i, got[i].SQL, c.want[i])
			}
		}
	}
}

func TestDBClassify(t *testing.T) {
	cases := []struct {
		d      dbDriver
		sql    string
		kind   dbStmtKind
		danger bool
		rows   bool
	}{
		{dbPostgres, "SELECT * FROM t WHERE a = 'DELETE FROM x'", dbKindRead, false, true},
		{dbPostgres, "select * from t for update", dbKindRead, false, true},
		{dbPostgres, "WITH x AS (SELECT 1) SELECT * FROM x", dbKindRead, false, true},
		{dbPostgres, "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", dbKindWrite, true, true},
		{dbPostgres, "WITH d AS (DELETE FROM t WHERE id = 1 RETURNING *) SELECT * FROM d", dbKindWrite, false, true},
		{dbPostgres, "EXPLAIN ANALYZE DELETE FROM t WHERE id = 3", dbKindWrite, false, true},
		{dbPostgres, "SELECT a INTO new_t FROM t", dbKindWrite, false, false},
		{dbPostgres, "WITH n AS (SELECT 1) INSERT INTO t SELECT * FROM n", dbKindWrite, false, false},
		{dbPostgres, "select replace(name, 'a', 'b') from t", dbKindRead, false, true},
		{dbPostgres, "UPDATE t SET a = 1", dbKindWrite, true, false},
		{dbPostgres, "UPDATE t SET a = 1 WHERE id = 2", dbKindWrite, false, false},
		{dbPostgres, "UPDATE t SET a = (SELECT max(b) FROM u WHERE u.x = 1)", dbKindWrite, true, false},
		{dbPostgres, "DELETE FROM t", dbKindWrite, true, false},
		{dbPostgres, "INSERT INTO t VALUES (1) RETURNING id", dbKindWrite, false, true},
		{dbPostgres, "insert into t values (1)", dbKindWrite, false, false},
		{dbPostgres, "DROP TABLE t", dbKindDDL, true, false},
		{dbPostgres, "create table t (id int references u on delete cascade on update cascade)", dbKindDDL, false, false},
		{dbPostgres, "TRUNCATE t", dbKindDDL, true, false},
		{dbPostgres, "BEGIN", dbKindTx, false, false},
		{dbPostgres, "commit", dbKindTx, false, false},
		{dbPostgres, "SET search_path = x", dbKindSession, false, false},
		{dbPostgres, "VACUUM", dbKindDDL, false, false},
		{dbPostgres, "frobnicate the thing", dbKindOther, false, false},
		{dbMySQL, "SHOW CREATE TABLE t", dbKindRead, false, true},
		{dbMySQL, "SHOW TABLES", dbKindRead, false, true},
		{dbMySQL, "INSERT INTO t (a) VALUES (1) ON DUPLICATE KEY UPDATE a = 2", dbKindWrite, false, false},
		{dbMySQL, "REPLACE INTO t VALUES (1)", dbKindWrite, false, false},
		{dbMySQL, "SELECT * FROM t INTO OUTFILE '/tmp/x'", dbKindWrite, false, false},
		{dbMySQL, "GRANT SELECT, UPDATE ON db.* TO u", dbKindDDL, false, false},
		{dbSQLite, "PRAGMA table_info(t)", dbKindRead, false, true},
		{dbSQLite, "PRAGMA main.index_list(t)", dbKindRead, false, true},
		{dbSQLite, "PRAGMA journal_mode = WAL", dbKindSession, false, false},
		{dbSQLite, "PRAGMA user_version(3)", dbKindSession, false, false},
		{dbSQLite, "PRAGMA user_version", dbKindRead, false, true},
		{dbSQLite, "CREATE TRIGGER tr AFTER UPDATE OF a ON t BEGIN SELECT 1; END", dbKindDDL, false, false},
		{dbSQLServer, "SELECT 1 DELETE FROM t", dbKindWrite, true, true},
		{dbSQLServer, "DECLARE @x int = 1; SELECT @x", dbKindRead, false, true},
		{dbSQLServer, "SELECT [update] FROM t", dbKindRead, false, true},
		{dbSQLServer, "BEGIN TRAN", dbKindTx, false, false},
		{dbSQLServer, "EXEC sp_who", dbKindWrite, false, true},
		{dbSQLServer, "SELECT * FROM t WITH (NOLOCK) WHERE @update = 1", dbKindRead, false, true},
		{dbSQLServer, "DELETE FROM t OUTPUT deleted.* WHERE id = 1", dbKindWrite, false, true},
	}
	for _, c := range cases {
		got := dbSplitStatements(c.d, c.sql)
		if len(got) != 1 {
			t.Errorf("%q: %d statements", c.sql, len(got))
			continue
		}
		g := got[0]
		if g.Kind != c.kind || g.Danger != c.danger || g.ReturnsRows != c.rows {
			t.Errorf("%s %q: kind=%s danger=%v rows=%v (reason %q), want kind=%s danger=%v rows=%v",
				c.d, c.sql, g.Kind, g.Danger, g.ReturnsRows, g.Reason, c.kind, c.danger, c.rows)
		}
	}
}

func TestDBBuildTableQuery(t *testing.T) {
	cols := map[string]bool{"id": true, "name": true, `we"ird`: true}
	q, cq, args, err := dbBuildTableQuery(dbPostgres, "public", "t", cols, nil,
		[]dbSort{{Column: "name", Desc: true}},
		[]dbFilter{{Column: "id", Op: "ge", Value: "3"}, {Column: `we"ird`, Op: "contains", Value: "50%_off!"}}, 100, 200)
	if err != nil {
		t.Fatal(err)
	}
	wantQ := `SELECT * FROM "public"."t" WHERE "id" >= $1 AND CAST("we""ird" AS TEXT) ILIKE $2 ESCAPE '!' ORDER BY "name" DESC LIMIT 100 OFFSET 200`
	if q != wantQ {
		t.Errorf("query:\n got %s\nwant %s", q, wantQ)
	}
	if cq != `SELECT COUNT(*) FROM "public"."t" WHERE "id" >= $1 AND CAST("we""ird" AS TEXT) ILIKE $2 ESCAPE '!'` {
		t.Errorf("count: %s", cq)
	}
	if len(args) != 2 || args[0] != "3" || args[1] != "%50!%!_off!!%" {
		t.Errorf("args: %#v", args)
	}
	q, _, _, err = dbBuildTableQuery(dbSQLServer, "dbo", "t]x", cols, nil, nil, []dbFilter{{Column: "name", Op: "starts", Value: "[a"}}, 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if q != `SELECT * FROM [dbo].[t]]x] WHERE CAST([name] AS NVARCHAR(MAX)) LIKE @p1 ESCAPE '!' ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY` {
		t.Errorf("mssql: %s", q)
	}
	if _, _, _, err := dbBuildTableQuery(dbMySQL, "s", "t", cols, nil, []dbSort{{Column: "id; drop table t"}}, nil, 1, 0); err == nil {
		t.Error("unknown sort column accepted")
	}
	if _, _, _, err := dbBuildTableQuery(dbMySQL, "s", "t", cols, nil, nil, []dbFilter{{Column: "id", Op: "; drop"}}, 1, 0); err == nil {
		t.Error("unknown filter op accepted")
	}
}

// A chave primária desempata a ordem: sem ordem total, LIMIT/OFFSET repete
// ou pula linhas entre páginas.
func TestDBBuildTableQueryOrdersByPK(t *testing.T) {
	cols := map[string]bool{"id": true, "seq": true, "name": true}
	pk := []string{"id", "seq"}
	q, _, _, _ := dbBuildTableQuery(dbPostgres, "public", "t", cols, pk, nil, nil, 10, 20)
	if q != `SELECT * FROM "public"."t" ORDER BY "id" ASC, "seq" ASC LIMIT 10 OFFSET 20` {
		t.Errorf("sem ordem escolhida: %s", q)
	}
	q, _, _, _ = dbBuildTableQuery(dbPostgres, "public", "t", cols, pk, []dbSort{{Column: "name"}, {Column: "seq", Desc: true}}, nil, 10, 0)
	if q != `SELECT * FROM "public"."t" ORDER BY "name" ASC, "seq" DESC, "id" ASC LIMIT 10 OFFSET 0` {
		t.Errorf("desempate: %s", q)
	}
	q, _, _, _ = dbBuildTableQuery(dbSQLServer, "dbo", "t", cols, pk, nil, nil, 10, 0)
	if q != `SELECT * FROM [dbo].[t] ORDER BY [id] ASC, [seq] ASC OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY` {
		t.Errorf("mssql: %s", q)
	}
}

func TestDBCellValue(t *testing.T) {
	if v, _, _ := dbCellValue(int64(1)<<60, ""); v != "1152921504606846976" {
		t.Errorf("big int: %#v", v)
	}
	if v, _, _ := dbCellValue(int64(42), ""); v != int64(42) {
		t.Errorf("int: %#v", v)
	}
	if v, _, _ := dbCellValue([]byte{0xff, 0x00, 0x10}, "BLOB"); v != "0xFF0010" {
		t.Errorf("blob: %#v", v)
	}
	if v, _, _ := dbCellValue([]byte("héllo"), "TEXT"); v != "héllo" {
		t.Errorf("text bytes: %#v", v)
	}
	guid := []byte{0x33, 0x22, 0x11, 0x00, 0x55, 0x44, 0x77, 0x66, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff}
	if v, _, _ := dbCellValue(guid, "UNIQUEIDENTIFIER"); v != "00112233-4455-6677-8899-AABBCCDDEEFF" {
		t.Errorf("guid: %#v", v)
	}
	long := make([]byte, dbMaxCellText+10)
	for i := range long {
		long[i] = 'a'
	}
	if v, cut, _ := dbCellValue(string(long), ""); !cut || len(v.(string)) > dbMaxCellText+4 {
		t.Errorf("long text not truncated")
	}
}

// O EXPLAIN do SQL Server (frontend explainSql): três lotes separados por GO,
// e o SET SHOWPLAN conta como leitura (não pede confirmação nem é barrado no
// somente leitura), sem devolver linhas.
func TestDBSQLServerShowplan(t *testing.T) {
	got := dbSplitStatements(dbSQLServer, "SET SHOWPLAN_TEXT ON\nGO\nSELECT * FROM t\nGO\nSET SHOWPLAN_TEXT OFF")
	if len(got) != 3 {
		t.Fatalf("lotes: %+v", got)
	}
	for _, i := range []int{0, 2} {
		if got[i].Kind != dbKindRead || got[i].ReturnsRows || got[i].Mutating() {
			t.Fatalf("SET SHOWPLAN [%d]: %+v", i, got[i])
		}
	}
	if got[1].Kind != dbKindRead || !got[1].ReturnsRows {
		t.Fatalf("SELECT: %+v", got[1])
	}
	// Outro SET continua mudando a sessão; no Postgres SET SHOWPLAN não existe.
	if s := dbSplitStatements(dbSQLServer, "SET NOCOUNT ON"); s[0].Kind != dbKindSession {
		t.Fatalf("SET NOCOUNT: %+v", s[0])
	}
	if s := dbSplitStatements(dbPostgres, "SET SHOWPLAN_TEXT ON"); s[0].Kind != dbKindSession {
		t.Fatalf("postgres: %+v", s[0])
	}
}
