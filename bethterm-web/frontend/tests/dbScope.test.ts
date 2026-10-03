import assert from "node:assert/strict";
import test from "node:test";
import { showsAllDatabases } from "../src/lib/dbScope.ts";

test("postgres e sql server listam os bancos mesmo com banco inicial", () => {
  assert.equal(showsAllDatabases(true), true);
});

test("mysql e sqlite não têm nível de banco", () => {
  assert.equal(showsAllDatabases(false), false);
});
