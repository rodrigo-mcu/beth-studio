import assert from "node:assert/strict";
import test from "node:test";
import { schemaFolders } from "../src/lib/dbSchemaFolders.ts";

test("postgres tem as pastas do schema", () => {
  assert.deepEqual(
    schemaFolders("postgres").map((f) => f.label),
    ["Tables", "Views", "Materialized Views", "Functions", "Queries"],
  );
});

test("mysql não tem materialized view", () => {
  assert.deepEqual(
    schemaFolders("mysql").map((f) => f.id),
    ["table", "view", "function", "query"],
  );
});

test("sqlite não lista funções", () => {
  assert.deepEqual(
    schemaFolders("sqlite").map((f) => f.id),
    ["table", "view", "query"],
  );
});
