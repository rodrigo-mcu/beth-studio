import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_CONNECTIONS, deleteSaved, emptyQueryStore, pushHistory, savedFor, saveQuery } from "../src/lib/dbQueryStore.ts";

test("histórico sobe o texto repetido e limita por conexão", () => {
  let s = emptyQueryStore();
  s = pushHistory(s, "c1", "select 1", "t1");
  s = pushHistory(s, "c1", "select 2", "t2");
  s = pushHistory(s, "c1", "select 1", "t3");
  assert.deepEqual(s.history.map((h) => h.sql), ["select 1", "select 2"]);
  assert.equal(s.history[0].at, "t3");
  s = pushHistory(s, "c1", "   ", "t4");
  assert.equal(s.history.length, 2);
});

test("consulta salva substitui o mesmo nome e pode ser apagada", () => {
  let s = saveQuery(emptyQueryStore(), "c1", "ativos", "select 1", "t1");
  s = saveQuery(s, "c1", "ativos", "select 2", "t2");
  assert.equal(s.saved.length, 1);
  assert.equal(s.saved[0].sql, "select 2");
  s = deleteSaved(s, s.saved[0].id);
  assert.equal(s.saved.length, 0);
});

test("consulta de todas as conexões aparece em qualquer uma, a da conexão só nela", () => {
  let s = saveQuery(emptyQueryStore(), ALL_CONNECTIONS, "Clientes ativos", "select 1", "t1");
  s = saveQuery(s, "c1", "Só do c1", "select 2", "t2");
  s = saveQuery(s, "c2", "Só do c2", "select 3", "t3");
  assert.deepEqual(savedFor(s, "c1").map((q) => q.name), ["Clientes ativos", "Só do c1"]);
  assert.deepEqual(savedFor(s, "c3").map((q) => q.name), ["Clientes ativos"]);
});

test("o mesmo nome pode existir para todas e para uma conexão", () => {
  let s = saveQuery(emptyQueryStore(), ALL_CONNECTIONS, "x", "select 1", "t1");
  s = saveQuery(s, "c1", "x", "select 2", "t2");
  assert.equal(s.saved.length, 2);
  s = saveQuery(s, ALL_CONNECTIONS, "x", "select 9", "t3");
  assert.equal(s.saved.length, 2);
});
