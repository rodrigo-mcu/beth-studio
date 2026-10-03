// Link na saída do terminal: OSC 8 de verdade manda (alvo real, não o texto
// visível); sem OSC 8, cai no fallback de URL/arquivo solto no texto.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFileCandidates, extractUrlCandidates, parseOsc8Spans, rowLinkCandidates, stripEscapes } from "../src/lib/termLinks.ts";

const ESC = "\x1b";
const BEL = "\x07";
function osc8(uri: string, label: string): string {
  return `${ESC}]8;;${uri}${BEL}${label}${ESC}]8;;${BEL}`;
}

test("parseOsc8Spans: rótulo diferente do alvo real (caso do print: 'Abrir pedidos-parceria.md')", () => {
  const uri = "file:///mnt/data/repo/projeto-video/lab/nuvem-cameras/pedidos-parceria.md";
  const row = osc8(uri, "Abrir pedidos-parceria.md");
  const spans = parseOsc8Spans(row);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].uri, uri);
  const visible = stripEscapes(row);
  assert.equal(visible, "Abrir pedidos-parceria.md");
  assert.equal(visible.slice(spans[0].start, spans[0].end), "Abrir pedidos-parceria.md");
});

test("parseOsc8Spans: preserva coluna com texto antes/depois do link, e SGR misturado", () => {
  const row = `antes ${ESC}[32m${osc8("https://example.com/x", "aqui")}${ESC}[0m depois`;
  const visible = stripEscapes(row);
  assert.equal(visible, "antes aqui depois");
  const spans = parseOsc8Spans(row);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].uri, "https://example.com/x");
  assert.equal(visible.slice(spans[0].start, spans[0].end), "aqui");
});

test("parseOsc8Spans: linha sem OSC 8 não produz span", () => {
  assert.deepEqual(parseOsc8Spans("texto qualquer sem link"), []);
});

test("extractFileCandidates: caminho relativo solto (sem OSC 8), caso do print", () => {
  const visible = "veja em lab/nuvem-cameras/pedidos-parceria.md para mais detalhes";
  const files = extractFileCandidates(visible);
  assert.equal(files.length, 1);
  assert.equal(files[0].uri, "lab/nuvem-cameras/pedidos-parceria.md");
});

test("extractUrlCandidates: domínio solto sem esquema, e com esquema", () => {
  const visible = "acesse portal.example.com ou https://partners.example.org/register para cadastro";
  const urls = extractUrlCandidates(visible);
  const uris = urls.map((u) => u.uri).sort();
  assert.deepEqual(uris, ["https://partners.example.org/register", "https://portal.example.com"]);
});

test("extractUrlCandidates: não confunde nome de arquivo (relatorio.md) com domínio", () => {
  const urls = extractUrlCandidates("salvei em relatorio.md");
  assert.deepEqual(urls, []);
});

test("rowLinkCandidates: com OSC 8, o alvo real manda; a URL solta no MESMO texto vira fallback só se não sobrepor", () => {
  const row = `${osc8("file:///C:/dados/repo/relatorio.md", "Abrir relatorio.md")} e depois https://example.com`;
  const spans = rowLinkCandidates(row);
  const osc8Spans = spans.filter((s) => s.kind === "osc8");
  const urlSpans = spans.filter((s) => s.kind === "url");
  assert.equal(osc8Spans.length, 1);
  assert.equal(osc8Spans[0].uri, "file:///C:/dados/repo/relatorio.md");
  assert.equal(urlSpans.length, 1);
  assert.equal(urlSpans[0].uri, "https://example.com");
});

test("rowLinkCandidates: sem OSC 8, cai no fallback (arquivo e url)", () => {
  const spans = rowLinkCandidates("abra lab/x/relatorio.md ou visite https://example.com/y agora");
  const kinds = spans.map((s) => s.kind).sort();
  assert.deepEqual(kinds, ["file", "url"]);
});

test("rowLinkCandidates: texto visível de um OSC8 que por acaso parece um caminho não vira também um candidato de arquivo duplicado", () => {
  const row = osc8("https://example.com/real-target", "abrir notas.md");
  const spans = rowLinkCandidates(row);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].kind, "osc8");
  assert.equal(spans[0].uri, "https://example.com/real-target");
});

// --- caso real: agente no WSL, OSC 8 + caminho solto entre parênteses ----
import { cellText, lineFallbackLinks, routeTermLink, spanColumns, type CellLike } from "../src/lib/termLinks.ts";

const WIDE = new Set(["⏺"]);
/** Células como o xterm faz: caractere largo ocupa 2 (a segunda com largura 0). */
function cellsOf(text: string): CellLike[] {
  const out: CellLike[] = [];
  for (const ch of text) {
    if (WIDE.has(ch)) out.push({ chars: ch, width: 2 }, { chars: "", width: 0 });
    else out.push({ chars: ch, width: 1 });
  }
  return out;
}

const WSL_PATH = "/mnt/data/repo/proj/lab/dir/pedidos-parceria.md";
const WSL_UNC = "\\\\wsl.localhost\\Debian\\mnt\\data\\repo\\proj\\lab\\dir\\pedidos-parceria.md";
const REAL_LINE = (target: string) =>
  `⏺ O texto está em ${osc8(target, "pedidos-parceria.md")} (${WSL_PATH}). Falta preencher os campos entre colchetes.`;

test("caso real WSL: o caminho solto vira UM link que termina na extensão (não passa do ')')", () => {
  const raw = REAL_LINE(`file://meu-pc${WSL_PATH}`);
  const visible = stripEscapes(raw);
  const links = lineFallbackLinks(cellsOf(visible), raw);
  // o rótulo OSC 8 "pedidos-parceria.md" NÃO ganha um segundo link
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, "file");
  assert.equal(links[0].uri, WSL_PATH);
  // colunas: "⏺" ocupa 2, então tudo depois dele anda uma coluna
  const at = visible.indexOf(WSL_PATH);
  assert.equal(links[0].x1, at + 1 + 1);
  assert.equal(links[0].x2, at + WSL_PATH.length + 1);
  const cells = cellsOf(visible);
  assert.equal(cells[links[0].x2 - 1].chars, "d"); // última coluna = "d" de ".md"
  assert.equal(cells[links[0].x2].chars, ")"); // ")" fica de fora
});

test("caso real WSL: clicar no OSC 8 OU no caminho solto abre o mesmo .md no painel (nunca navegador)", () => {
  const ctxs = [
    { paneKind: "wsl", paneWsl: true, paneDistro: "Debian", paneCwd: "file://meu-pc/mnt/data/repo/proj" },
    // agente classificado como "other", mas o Go marcou wsl + distro
    { paneKind: "other", paneWsl: true, paneDistro: "Debian", paneCwd: "file://meu-pc/mnt/data/repo/proj" },
  ];
  for (const ctx of ctxs) {
    for (const target of [`file://meu-pc${WSL_PATH}`, `file://${WSL_PATH}`, `file://localhost${WSL_PATH.replace("pedidos", "%70edidos")}`, WSL_PATH]) {
      assert.deepEqual(routeTermLink(target, ctx), { kind: "file", path: WSL_UNC }, `${ctx.paneKind} ${target}`);
    }
  }
});

test("routeTermLink: http vai pro navegador; esquema estranho ou extensão fora da lista não é clicável", () => {
  const ctx = { paneKind: "wsl", paneWsl: true, paneDistro: "Debian" };
  assert.deepEqual(routeTermLink("https://example.com/x", ctx), { kind: "http", url: "https://example.com/x" });
  assert.equal(routeTermLink("mailto:a@example.com", ctx), null);
  assert.equal(routeTermLink("vscode://file/mnt/data/x.md", ctx), null);
  assert.equal(routeTermLink("file:///mnt/data/app.exe", ctx), null);
  assert.equal(routeTermLink("file:///mnt/data/repo/", ctx), null);
  assert.equal(routeTermLink(WSL_PATH, { paneKind: "powershell" }), null); // Linux num pane Windows
  assert.deepEqual(routeTermLink("/mnt/c/Users/u/notes.md", ctx), { kind: "file", path: "C:\\Users\\u\\notes.md" });
});

test("extractFileCandidates: termina na extensão e tira pontuação/aspas/crase", () => {
  const got = (s: string) => extractFileCandidates(s).map((c) => c.uri);
  assert.deepEqual(got("veja (/mnt/data/x.md). Falta"), ["/mnt/data/x.md"]);
  assert.deepEqual(got("veja `/mnt/data/x.md`, ok"), ["/mnt/data/x.md"]);
  assert.deepEqual(got("veja [/mnt/data/x.md]: ok"), ["/mnt/data/x.md"]);
  assert.deepEqual(got("veja '/mnt/data/x.md'; ok"), ["/mnt/data/x.md"]);
  assert.deepEqual(got('veja "/mnt/data/x.png"!'), ["/mnt/data/x.png"]);
  assert.deepEqual(got("salvo em C:\\dados\\notes.log."), ["C:\\dados\\notes.log"]);
  assert.deepEqual(got("não: notes.md.bak notes.mdx notes.md5"), []);
});

test("cellText/spanColumns: emoji (2 unidades UTF-16) e caractere largo mapeiam para a coluna certa", () => {
  const ct = cellText([{ chars: "😀", width: 2 }, { chars: "", width: 0 }, { chars: "a", width: 1 }, { chars: "b", width: 1 }]);
  assert.equal(ct.text, "😀ab");
  assert.deepEqual(spanColumns(ct, 2, 4), { x1: 3, x2: 4 });
  assert.deepEqual(spanColumns(ct, 0, 2), { x1: 1, x2: 2 });
});

test("linha crua diferente das células: ainda não põe link por cima do rótulo OSC 8", () => {
  const raw = REAL_LINE(`file://${WSL_PATH}`);
  const cells = cellsOf("x" + stripEscapes(raw)); // uma coluna a mais: não bate
  const links = lineFallbackLinks(cells, raw);
  assert.deepEqual(links.map((l) => l.uri), [WSL_PATH]);
});
