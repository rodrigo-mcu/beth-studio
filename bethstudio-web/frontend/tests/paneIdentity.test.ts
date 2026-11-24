import { test } from "node:test";
import assert from "node:assert/strict";
import { paneIdentity } from "../src/lib/paneIdentity.ts";

test("Codex com título brian mostra Codex nos dois lugares", () => {
  const id = paneIdentity({ title: "brian", screen: "OpenAI Codex (v0.170.0)" }, "Terminal 5");
  assert.equal(id.name, "Codex");
  assert.equal(id.tool, "codex");
});

test("ferramenta gravada na aba vence o título do shell", () => {
  const id = paneIdentity({ title: "brian", stored: "codex" }, "Terminal 5");
  assert.equal(id.name, "Codex");
  assert.equal(id.tool, "codex");
});

test("shell comum fica com o próprio título e sem ferramenta", () => {
  const id = paneIdentity({ title: "zsh" }, "Terminal 1");
  assert.equal(id.name, "zsh");
  assert.equal(id.tool, undefined);
});

test("ferramenta do painel vence o título brian e devolve o ícone", () => {
  const id = paneIdentity({ title: "brian", tool: "codex" }, "Terminal 5");
  assert.equal(id.name, "Codex");
  assert.equal(id.tool, "codex");
});

test("Cursor ativo corrige um rótulo Grok guardado na aba", () => {
  assert.equal(paneIdentity({ title: "Cursor", stored: "grok", tool: "grok" }, "").tool, "cursor");
  assert.equal(paneIdentity({ title: "brian", stored: "grok", screen: "Cursor Agent\nGrok" }, "").tool, "cursor");
});
