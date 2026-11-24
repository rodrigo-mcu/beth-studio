import { test } from "node:test";
import assert from "node:assert/strict";
import { highlightCode, langOf } from "../src/lib/codeHighlight.ts";

test("langOf reconhece Copper e as linguagens comuns", () => {
  assert.equal(langOf("guard.crs"), "crs");
  assert.equal(langOf("app.mika"), "crs");
  assert.equal(langOf("hello.mui"), "mui");
  assert.equal(langOf("main.rs"), "rust");
  assert.equal(langOf("Main.java"), "java");
  assert.equal(langOf("notas.md"), "plain");
});

test("highlightCode segue os escopos da extensão do Copper, não os do Rust", () => {
  const segs = highlightCode('func int main() {\n  let s = "oi" // fim\n  println!()\n}', "crs");
  const text = segs.map((s) => s.text).join("");
  assert.equal(text, 'func int main() {\n  let s = "oi" // fim\n  println!()\n}');
  assert.equal(segs.find((s) => s.text === "func")?.tok, "decl");
  assert.equal(segs.find((s) => s.text === "int")?.tok, "prim");
  assert.equal(segs.find((s) => s.text === "main")?.tok, "fn");
  assert.equal(segs.find((s) => s.text === "let")?.tok, "decl");
  assert.equal(segs.find((s) => s.text === "println")?.tok, "macro");
  assert.equal(segs.find((s) => s.text === '"oi"')?.tok, "str");
  assert.equal(segs.find((s) => s.text.startsWith("///")) , undefined);
  const doc = highlightCode("/// doc", "crs");
  assert.equal(doc[0]?.tok, "doc");
});

test("highlightCode não come o texto", () => {
  const src = "int x = 1; /* a */ string";
  assert.equal(highlightCode(src, "crs").map((s) => s.text).join(""), src);
  assert.equal(highlightCode(src, "crs").find((s) => s.text === "int")?.tok, "prim");
  assert.equal(highlightCode(src, "crs").find((s) => s.text === "string")?.tok, "prim");
});
