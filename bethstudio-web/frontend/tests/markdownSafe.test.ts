// Renderização de Markdown para o painel de preview: sandbox (sem script,
// sem HTML bruto, sem esquema perigoso em link/imagem).
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdownSafe } from "../src/lib/markdownSafe.ts";

test("renderiza markdown normal", () => {
  const html = renderMarkdownSafe("# título\n\ntexto com **negrito**.");
  assert.match(html, /<h1>título<\/h1>/);
  assert.match(html, /<strong>negrito<\/strong>/);
});

test("HTML bruto embutido no markdown não é interpretado (vira texto escapado)", () => {
  const html = renderMarkdownSafe("<script>alert(1)</script>\n\ntexto");
  assert.ok(!/<script>/i.test(html));
  assert.match(html, /&lt;script&gt;/);
});

test("img onerror embutido não sobrevive", () => {
  const html = renderMarkdownSafe('<img src=x onerror="alert(1)">');
  assert.ok(!/onerror/i.test(html));
});

test("link javascript: não vira href clicável", () => {
  const html = renderMarkdownSafe("[clique](javascript:alert(1))");
  assert.ok(!/href="javascript:/i.test(html));
});

test("imagem relativa sem saber a pasta do .md não carrega nada (vira o texto alternativo)", () => {
  const html = renderMarkdownSafe("![captura](clipboard-images/x.png)");
  assert.ok(!/<img/.test(html));
  assert.match(html, /captura/);
});
