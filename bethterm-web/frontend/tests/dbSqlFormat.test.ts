import { test } from "node:test";
import assert from "node:assert/strict";
import { explainSql, findSpans, formatSql, replaceAllText, toInsertSQL } from "../src/lib/dbSqlFormat.ts";

test("formatar SQL põe cláusulas em linhas e não mexe em texto", () => {
  const out = formatSql("select a,b from t where x=1 and y=2", "postgres");
  assert.match(out, /^SELECT a,\n {2}b\nFROM t\nWHERE x = 1\n {2}AND y = 2\n$/);
  const kept = formatSql("select 'select a, b from t' from t", "postgres");
  assert.match(kept, /'select a, b from t'/);
  assert.match(kept, /\nFROM t\n/);
  const fn = formatSql("select count(a, b) from t", "postgres");
  assert.match(fn, /count\(a, b\)/);
  assert.doesNotMatch(fn, /count\(\na/);
});

test("plano de execução por driver", () => {
  assert.equal(explainSql("postgres", "select 1"), "EXPLAIN\nselect 1");
  assert.equal(explainSql("sqlite", "select 1;"), "EXPLAIN QUERY PLAN\nselect 1");
  assert.equal(explainSql("mysql", "EXPLAIN select 1"), "EXPLAIN select 1");
  // SET SHOWPLAN sozinho no lote: separado por GO (com ";" o SQL Server recusa)
  assert.equal(explainSql("sqlserver", "select 1;"), "SET SHOWPLAN_TEXT ON\nGO\nselect 1\nGO\nSET SHOWPLAN_TEXT OFF");
});

test("INSERT só do que está na grade", () => {
  const sql = toInsertSQL("pedidos", [{ name: "id", type: "int" }, { name: "nome", type: "text" }], [[1, "O'Hara"], [2, null]], "postgres");
  assert.match(sql, /INSERT INTO "pedidos" \("id", "nome"\) VALUES \(1, 'O''Hara'\);/);
  assert.match(sql, /VALUES \(2, NULL\);/);
  assert.match(toInsertSQL("t", [{ name: "a", type: "int" }], [[1]], "mysql"), /`t`/);
});

test("INSERT: binário, booleano, barra invertida, data e célula cortada por banco", () => {
  const cols = [
    { name: "b", type: "VARBINARY" },
    { name: "ok", type: "BIT" },
    { name: "t", type: "TEXT" },
  ];
  const row = [["0xCAFE", true, "C:\\x 'y'"]];
  assert.match(toInsertSQL("t", cols, row, "sqlserver"), /VALUES \(0xCAFE, 1, N'C:\\x ''y'''\);/);
  assert.match(toInsertSQL("t", cols, row, "mysql"), /VALUES \(0xCAFE, TRUE, 'C:\\\\x ''y'''\);/);
  assert.match(toInsertSQL("t", cols, row, "postgres"), /VALUES \('\\xcafe'::bytea, TRUE, 'C:\\x ''y'''\);/);
  assert.match(toInsertSQL("t", cols, row, "sqlite"), /VALUES \(X'CAFE', 1, 'C:\\x ''y'''\);/);
  // "0x..." numa coluna de texto continua texto
  assert.match(toInsertSQL("t", [{ name: "t", type: "TEXT" }], [["0xCAFE"]], "postgres"), /VALUES \('0xCAFE'\);/);
  // data e hora: o MySQL estrito não aceita o "T" e o "Z"
  assert.match(toInsertSQL("t", [{ name: "d", type: "DATETIME" }], [["2026-09-30T12:34:56.5Z"]], "mysql"), /'2026-09-30 12:34:56\.5'/);
  // célula cortada sai NULL, com aviso no topo
  const big = "a".repeat(64 << 10) + "…";
  const sql = toInsertSQL("t", [{ name: "t", type: "TEXT" }, { name: "b", type: "BLOB" }], [[big, "0x" + "AB".repeat(4096) + "…"]], "postgres");
  assert.match(sql, /^-- ATENÇÃO: 2 célula\(s\)/);
  assert.match(sql, /VALUES \(NULL, NULL\);/);
  // um texto comum que termina em "…" não é corte
  assert.match(toInsertSQL("t", [{ name: "t", type: "TEXT" }], [["e então…"]], "postgres"), /VALUES \('e então…'\);/);
});

test("localizar e substituir", () => {
  assert.deepEqual(findSpans("Aa aa", "aa", false).map((s) => s.start), [0, 3]);
  const r = replaceAllText("id = id", "id", "pk", false);
  assert.equal(r.count, 2);
  assert.equal(r.text, "pk = pk");
});
