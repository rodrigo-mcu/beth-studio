import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Cargo.toml, Cargo.lock e .toml usam o símbolo do vscode-symbols", () => {
  const src = readFileSync(new URL("../src/lib/fileSymbols.ts", import.meta.url), "utf8");
  assert.match(src, /"cargo\.toml": rust/);
  assert.match(src, /"cargo\.lock": lock/);
  assert.match(src, /toml: gear/);
  assert.match(src, /from "@\/assets\/symbols\/gear\.svg"/);
  assert.match(src, /from "@\/assets\/symbols\/lock\.svg"/);
  assert.match(src, /from "@\/assets\/symbols\/rust\.svg"/);
});
