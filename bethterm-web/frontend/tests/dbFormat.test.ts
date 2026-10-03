import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cellDisplay,
  cellRaw,
  csvCell,
  exportFileName,
  formatMs,
  isNumericType,
  quoteIdent,
  resultSummary,
  rowTSV,
  rowsTSV,
  toCSV,
  toJSON,
  uniqueNames,
} from "../src/lib/dbFormat.ts";
import { highlightSql } from "../src/lib/dbSqlHighlight.ts";

const cols = [{ name: "id", type: "INTEGER" }, { name: "nome", type: "TEXT" }, { name: "id" }];

test("cellRaw/cellDisplay", () => {
  assert.equal(cellRaw(null), "");
  assert.equal(cellDisplay(null), "NULL");
  assert.equal(cellRaw(true), "true");
  assert.equal(cellDisplay("a\nb\tc"), "a ↵ b c");
  assert.equal(cellDisplay("x".repeat(300), 10), "xxxxxxxxxx…");
});

test("CSV com aspas, separador e quebra de linha", () => {
  assert.equal(csvCell('diz "oi"', ","), '"diz ""oi"""');
  assert.equal(csvCell("a;b", ";"), '"a;b"');
  assert.equal(csvCell("a;b", ","), "a;b");
  const csv = toCSV(cols, [[1, "Ana, a\nsegunda", null]], ",", false);
  assert.equal(csv, 'id,nome,id\r\n1,"Ana, a\nsegunda",\r\n');
  assert.ok(toCSV(cols, [], ";").startsWith("﻿"));
});

test("JSON com nomes repetidos", () => {
  assert.deepEqual(uniqueNames(cols), ["id", "nome", "id_2"]);
  const j = JSON.parse(toJSON(cols, [[1, "Ana", 7]]));
  assert.deepEqual(j, [{ id: 1, nome: "Ana", id_2: 7 }]);
});

test("TSV para colar em planilha", () => {
  assert.equal(rowTSV([1, "a\tb", null, "x\ny"]), "1\ta b\t\tx y");
  assert.equal(rowsTSV(cols, [[1, "a", 2]]), "id\tnome\tid\r\n1\ta\t2");
});

test("tipos numéricos", () => {
  for (const t of ["INTEGER", "int4", "BIGINT", "DECIMAL(10,2)", "numeric", "UNSIGNED BIGINT", "float8", "MONEY"]) assert.ok(isNumericType(t), t);
  for (const t of ["TEXT", "POINT", "INTERVAL", "VARCHAR(10)", "", undefined]) assert.ok(!isNumericType(t), String(t));
});

test("nome de arquivo e tempos", () => {
  const d = new Date(2026, 8, 25, 14, 3);
  assert.equal(exportFileName("Relatório de vendas/2026", "csv", d), "Relatorio_de_vendas_2026_2026-09-25_14-03.csv");
  assert.equal(exportFileName("???", "json", d), "resultado_2026-09-25_14-03.json");
  assert.equal(formatMs(850), "850 ms");
  assert.equal(formatMs(1250), "1,3 s");
  assert.equal(formatMs(125000), "2 min 5 s");
});

test("resumo do resultado", () => {
  assert.equal(resultSummary({ has_rows: true, rows: [1, 2], has_more: true, truncated: "rows", elapsed_ms: 5 }), "2 linhas+ · 5 ms");
  assert.equal(resultSummary({ has_rows: false, rows: [], affected: 1, has_more: false, elapsed_ms: 3 }), "1 linha afetada · 3 ms");
  assert.equal(resultSummary({ has_rows: false, rows: [], has_more: false, elapsed_ms: 0 }), "comando executado · 0 ms");
});

test("aspas de identificador por banco", () => {
  assert.equal(quoteIdent("postgres", 'a"b'), '"a""b"');
  assert.equal(quoteIdent("mysql", "a`b"), "`a``b`");
  assert.equal(quoteIdent("sqlserver", "a]b"), "[a]]b]");
});

test("realce de SQL preserva o texto e classifica", () => {
  const src = "SELECT nome, count(*) -- total\nFROM \"t\" WHERE x = 'a''b' AND y > 1.5e3 AND z = $1; /* fim */ select $$a;b$$";
  const segs = highlightSql(src, "postgres");
  assert.equal(segs.map((s) => s.text).join(""), src);
  const cls = (t: string) => segs.find((s) => s.text === t)?.cls;
  assert.equal(cls("SELECT"), "kw");
  assert.equal(cls("count"), "fn");
  assert.equal(cls("-- total"), "com");
  assert.equal(cls('"t"'), "ident");
  assert.equal(cls("'a''b'"), "str");
  assert.equal(cls("1.5e3"), "num");
  assert.equal(cls("$1"), "param");
  assert.equal(cls("$$a;b$$"), "str");
  assert.equal(cls("/* fim */"), "com");
  const my = highlightSql("select `a` # c\n, 'x\\'y'", "mysql");
  assert.equal(my.map((s) => s.text).join(""), "select `a` # c\n, 'x\\'y'");
  assert.equal(my.find((s) => s.text === "# c")?.cls, "com");
  assert.equal(my.find((s) => s.text === "'x\\'y'")?.cls, "str");
  const ms = highlightSql("SELECT [a b], @x FROM t", "sqlserver");
  assert.equal(ms.find((s) => s.text === "[a b]")?.cls, "ident");
  assert.equal(ms.find((s) => s.text === "@x")?.cls, "param");
  // texto não terminado não quebra
  assert.equal(highlightSql("select 'abc", "sqlite").map((s) => s.text).join(""), "select 'abc");
});
