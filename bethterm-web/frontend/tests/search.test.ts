import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lastFolder,
  matchEntry,
  mergeRanges,
  normalize,
  normalizeWithMap,
  search,
  snippet,
  stripAnsi,
  terms,
  type SearchEntry,
} from "../src/lib/search.ts";

const e = (pane: number, fields: [SearchEntry["fields"][0]["kind"], string][], gone = false): SearchEntry => ({
  pane,
  gone,
  fields: fields.map(([kind, text]) => ({ kind, label: kind, text })),
});

test("normalizacao NFD: sem acento e sem maiusculas", () => {
  assert.equal(normalize("Conexão MASTER Ação ç"), "conexao master acao c");
  assert.deepEqual(terms("  Conexão   lpr "), ["conexao", "lpr"]);
});

test("mapa de indices sobrevive a acentos decompostos", () => {
  const s = "Açãob"; // 5 chars
  const { norm, map } = normalizeWithMap(s);
  assert.equal(norm, "acaob");
  const at = norm.indexOf("aob");
  assert.equal(s.slice(map[at], map[at + 3]), "ãob");
  // texto ja' decomposto (NFD) na origem
  const d = "Sa\u0303o";
  const n2 = normalizeWithMap(d);
  assert.equal(n2.norm, "sao");
  assert.equal(d.slice(n2.map[1], n2.map[3]), "a\u0303o");
});

test("varios termos = E logico, em campos diferentes", () => {
  const x = e(28, [
    ["title", "✳ Conexão master LPR via PROXY"],
    ["cwd", "/mnt/data/src/repo/infra/network"],
    ["webtab", "Servidores"],
  ]);
  assert.ok(matchEntry(x, terms("conexao network")));
  assert.ok(matchEntry(x, terms("SERVIDORES lpr")));
  assert.equal(matchEntry(x, terms("conexao billing")), null);
});

test("destaque aponta para o texto original", () => {
  const x = e(1, [["title", "Pagina locais web contratos ativos"]]);
  const r = matchEntry(x, terms("LOCAIS contr"))!;
  const h = r.hits[0];
  assert.deepEqual(
    h.ranges.map(([a, b]) => h.field.text.slice(a, b)),
    ["locais", "contr"],
  );
  assert.deepEqual(mergeRanges([[5, 8], [1, 3], [2, 6]]), [[1, 8]]);
});

test("ordem: titulo antes de conteudo; encerrado por ultimo", () => {
  const a = e(1, [["title", "nada"], ["content", "deploy feito"]]);
  const b = e(2, [["title", "deploy do billing"]]);
  const c = e(3, [["title", "deploy velho"]], true);
  assert.deepEqual(
    search([a, b, c], "deploy").map((r) => r.entry.pane),
    [2, 3, 1],
  );
  assert.deepEqual(search([a, b], "   "), []);
});

test("busca por id e pasta final", () => {
  const x = e(31, [["id", "pane 31 #31"], ["folder", "team-docs"], ["cwd", "/mnt/data/src/repo/team-docs/"]]);
  assert.ok(matchEntry(x, terms("#31")));
  assert.ok(matchEntry(x, terms("docs")));
  assert.equal(lastFolder("C:\\src\\repo\\app\\"), "app");
  assert.equal(lastFolder("/mnt/x/team-docs/"), "team-docs");
});

test("stripAnsi e trecho do conteudo", () => {
  const raw = "\x1b[0m\x1b[1;32mOK\x1b[0m build \x1b]8;;file:///x\x1b\\link\x1b]8;;\x1b\\   \r\n\x1b(Bsegunda   ";
  assert.equal(stripAnsi(raw), "OK build link\nsegunda");
  const text = "linha um\n" + "x".repeat(100) + " erro fatal aqui " + "y".repeat(100) + "\nfim";
  const at = text.indexOf("erro");
  const s = snippet(text, [[at, at + 4]], 20);
  assert.ok(s.text.startsWith("…") && s.text.endsWith("…"));
  assert.equal(s.text.slice(s.ranges[0][0], s.ranges[0][1]), "erro");
});
