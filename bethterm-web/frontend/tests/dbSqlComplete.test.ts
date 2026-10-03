import assert from "node:assert/strict";
import test from "node:test";
import { completeSql, type SqlCatalog } from "../src/lib/dbSqlComplete.ts";

const cat: SqlCatalog = {
  defaultSchema: "public",
  schemas: ["public", "audit"],
  tables: [
    {
      schema: "public",
      name: "clientes",
      type: "table",
      columns: [
        { name: "id", type: "int", pk: true },
        { name: "nome", type: "text" },
        { name: "email", type: "text" },
      ],
    },
    { schema: "public", name: "pedidos", type: "table" },
    { schema: "audit", name: "clientes", type: "view" },
    { schema: "public", name: "order", type: "table" },
  ],
};

test("depois de FROM sugere a tabela pelo prefixo", () => {
  const sql = "SELECT * FROM cli";
  const r = completeSql(sql, sql.length, "postgres", cat);
  assert.ok(r);
  assert.equal(r.start, sql.length - 3);
  assert.ok(r.items.some((i) => i.insert === "clientes" && i.kind === "table"));
  assert.equal(r.items.some((i) => i.kind === "keyword"), false);
});

test("alias.coluna oferece as colunas e pede as que faltam", () => {
  const sql = "SELECT c. FROM clientes c";
  const at = sql.indexOf("c.") + 2;
  const r = completeSql(sql, at, "postgres", cat);
  assert.ok(r);
  assert.equal(r.wide, true);
  assert.deepEqual(
    r.items.map((i) => i.label),
    ["id", "email", "nome"],
  );
  assert.equal(r.items[0].detail?.startsWith("pk"), true);
  const sql2 = "SELECT p. FROM pedidos p";
  const r2 = completeSql(sql2, sql2.indexOf("p.") + 2, "postgres", cat);
  assert.ok(r2);
  assert.deepEqual(r2.missing, [{ schema: "public", table: "pedidos" }]);
});

test("prefixo de coluna filtra", () => {
  const sql = "SELECT nome FROM clientes WHERE n";
  const r = completeSql(sql, sql.length, "postgres", cat);
  assert.ok(r);
  assert.ok(r.items.some((i) => i.label === "nome" && i.kind === "column"));
  assert.equal(r.items.some((i) => i.label === "id"), false);
});

test("dentro de string não sugere", () => {
  assert.equal(completeSql("SELECT 'cli", "SELECT 'cli".length, "postgres", cat), null);
  assert.equal(completeSql("SELECT 1 -- FROM cli", "SELECT 1 -- FROM cli".length, "postgres", cat), null);
});

test("schema.tabela lista só aquele schema", () => {
  const sql = "SELECT * FROM audit.";
  const r = completeSql(sql, sql.length, "postgres", cat);
  assert.ok(r);
  assert.deepEqual(
    r.items.map((i) => i.label),
    ["clientes"],
  );
  assert.equal(r.items[0].kind, "view");
  assert.match(r.items[0].insert, /audit\.clientes/);
});

test("nome reservado entra citado no MySQL", () => {
  const sql = "SELECT * FROM ord";
  const r = completeSql(sql, sql.length, "mysql", cat);
  assert.ok(r);
  const hit = r.items.find((i) => i.label === "order");
  assert.equal(hit?.insert, "`order`");
});

test("Ctrl+Space no meio da cláusula mistura coluna, função e palavra", () => {
  const sql = "SELECT ";
  const r = completeSql(sql, sql.length, "postgres", cat, { force: true });
  assert.ok(r);
  assert.ok(r.items.some((i) => i.kind === "fn" && i.insert === "COUNT("));
  assert.ok(r.items.some((i) => i.kind === "keyword"));
});

test("prefixo vazio fora de FROM não abre sozinho", () => {
  assert.equal(completeSql("SELECT * FROM clientes ", "SELECT * FROM clientes ".length, "postgres", cat), null);
});
