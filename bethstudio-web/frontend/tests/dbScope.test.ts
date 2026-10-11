import assert from "node:assert/strict";
import test from "node:test";
import { showsAllDatabases } from "../src/lib/dbScope.ts";

test("postgres e sql server sem banco inicial listam os bancos", () => {
  assert.equal(showsAllDatabases(true), true);
  assert.equal(showsAllDatabases(true, ""), true);
  assert.equal(showsAllDatabases(true, "  "), true);
});

test("com banco inicial preenchido abre só aquele banco", () => {
  assert.equal(showsAllDatabases(true, "clientes"), false);
});

test("mysql e sqlite não têm nível de banco", () => {
  assert.equal(showsAllDatabases(false), false);
});
