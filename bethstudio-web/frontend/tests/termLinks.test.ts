// Link na saída do terminal: OSC 8 de verdade manda (alvo real, não o texto
// visível); sem OSC 8, cai no fallback de URL/arquivo solto no texto.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { extractFileCandidates, extractFolderCandidates, extractUrlCandidates, parseOsc8Spans, rowLinkCandidates, stripEscapes } from "../src/lib/termLinks.ts";

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
import { cellText, fallbackLinksTouching, lineFallbackLinks, linkHoverHint, routeTermLink, shouldActivateLink, spanColumns, suppressAppMouseDown, type CellLike } from "../src/lib/termLinks.ts";

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

test("routeTermLink: http vai pro navegador; esquema estranho ou pasta não é clicável; executável vai para a pasta", () => {
  const ctx = { paneKind: "wsl", paneWsl: true, paneDistro: "Debian" };
  assert.deepEqual(routeTermLink("https://example.com/x", ctx), { kind: "http", url: "https://example.com/x" });
  assert.equal(routeTermLink("mailto:a@example.com", ctx), null);
  assert.equal(routeTermLink("vscode://file/mnt/data/x.md", ctx), null);
  assert.deepEqual(routeTermLink("file:///mnt/data/app.exe", ctx), {
    kind: "reveal",
    path: "\\\\wsl.localhost\\Debian\\mnt\\data\\app.exe",
  });
  assert.deepEqual(routeTermLink("file:///mnt/data/repo/", ctx), { kind: "folder", path: ["", "", "wsl.localhost", "Debian", "mnt", "data", "repo"].join(String.fromCharCode(92)) });
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

const WIN = { paneKind: "powershell", paneCwd: "file:///D:/docs/" };

test("caminho Windows com barras invertidas (.pdf .docx .xlsx .zip) abre no programa padrão", () => {
  const cases = ["D:\\docs\\manual.pdf", "D:\\docs\\relatorio.docx", "D:\\docs\\planilha.xlsx", "D:\\docs\\pacote.zip"];
  for (const raw of cases) {
    const visible = `veja ${raw} agora`;
    const files = extractFileCandidates(visible);
    assert.equal(files.length, 1, raw);
    assert.equal(files[0].uri, raw);
    assert.deepEqual(routeTermLink(raw, WIN), { kind: "open", path: raw }, raw);
    const links = lineFallbackLinks(cellsOf(visible), visible);
    assert.equal(links.length, 1, raw);
    assert.equal(links[0].uri, raw);
    const at = visible.indexOf(raw);
    assert.equal(links[0].x1, at + 1, raw);
    assert.equal(links[0].x2, at + raw.length, raw);
  }
});

test("caminho com espaços entre aspas: o intervalo não inclui as aspas", () => {
  const path = "D:\\docs\\meu arquivo.pdf";
  const visible = `abra "${path}" por favor`;
  const files = extractFileCandidates(visible);
  assert.deepEqual(files.map((f) => f.uri), [path]);
  const links = lineFallbackLinks(cellsOf(visible), visible);
  assert.equal(links.length, 1);
  assert.equal(links[0].uri, path);
  const at = visible.indexOf(path);
  assert.equal(links[0].x1, at + 1);
  assert.equal(links[0].x2, at + path.length);
  assert.equal(visible[links[0].x1 - 2], '"');
  assert.equal(visible[links[0].x2], '"');
});

test("executável e similares não abrem: mostram o arquivo na pasta", () => {
  for (const ext of [".exe", ".bat", ".cmd", ".ps1", ".lnk", ".js", ".vbs", ".msi", ".scr"]) {
    const path = `D:\\docs\\ferramenta${ext}`;
    assert.deepEqual(routeTermLink(path, WIN), { kind: "reveal", path }, ext);
  }
});

test("file://, til, relativo e WSL de um .pdf abrem no programa padrão", () => {
  assert.deepEqual(routeTermLink("file:///D:/docs/manual.pdf", WIN), { kind: "open", path: "D:\\docs\\manual.pdf" });
  assert.deepEqual(routeTermLink("~\\docs\\manual.pdf", WIN), { kind: "open", path: "~\\docs\\manual.pdf" });
  assert.deepEqual(routeTermLink("~/docs/manual.pdf", WIN), { kind: "open", path: "~\\docs\\manual.pdf" });
  assert.deepEqual(routeTermLink("manual.pdf", WIN), { kind: "open", path: "D:\\docs\\manual.pdf" });
  const wsl = { paneKind: "wsl", paneWsl: true, paneDistro: "Debian", paneCwd: "file://wsl.localhost/Debian/home/u" };
  assert.deepEqual(routeTermLink("/home/u/docs/manual.pdf", wsl), {
    kind: "open",
    path: "\\\\wsl.localhost\\Debian\\home\\u\\docs\\manual.pdf",
  });
  assert.deepEqual(routeTermLink("/mnt/d/docs/manual.pdf", wsl), { kind: "open", path: "D:\\docs\\manual.pdf" });
});

test("URL solta e OSC 8 com texto here abrem no navegador", () => {
  const uri = "https://example.com/device?code=ABCD";
  assert.deepEqual(routeTermLink(uri, WIN), { kind: "http", url: uri });
  const row = `Click ${osc8(uri, "here")} to show full URL`;
  const spans = parseOsc8Spans(row);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].uri, uri);
  assert.equal(stripEscapes(row).slice(spans[0].start, spans[0].end), "here");
  const visible = stripEscapes(row);
  const links = lineFallbackLinks(cellsOf(visible), row);
  assert.deepEqual(links.map((l) => l.uri), []);
});

test("caractere largo antes do .pdf: a coluna acompanha a largura", () => {
  const path = "D:\\docs\\manual.pdf";
  const visible = `⏺ ${path}`;
  const links = lineFallbackLinks(cellsOf(visible), visible);
  assert.equal(links.length, 1);
  const at = visible.indexOf(path);
  assert.equal(links[0].x1, at + 1 + 1);
  assert.equal(links[0].x2, at + path.length + 1);
  assert.equal(links[0].uri, path);
});

test("linha mais longa que as células visíveis: o caminho inteiro continua sendo o alvo", () => {
  const full = "D:\\docs\\sub\\manual.pdf";
  const visible = full.slice(0, 12);
  const links = lineFallbackLinks(cellsOf(visible), full);
  assert.equal(links.length, 1);
  assert.equal(links[0].uri, full);
  assert.equal(links[0].x1, 1);
  assert.equal(links[0].x2, visible.length);
});

test("caminho quebrado com isWrapped: o alvo é o caminho inteiro e as colunas batem em cada pedaço", () => {
  const path = "D:\\docs\\manual.pdf";
  const cut = 8;
  const head = `veja ${path.slice(0, cut)}`;
  const tail = path.slice(cut);
  const rows = [
    { cells: cellsOf(head), wrapped: false, raw: head },
    { cells: cellsOf(tail), wrapped: true, raw: tail },
  ];
  const links = fallbackLinksTouching(rows, 1);
  assert.equal(links.length, 1);
  assert.equal(links[0].uri, path);
  assert.equal(links[0].y1, 1);
  assert.equal(links[0].x1, "veja ".length + 1);
  assert.equal(links[0].y2, 2);
  assert.equal(links[0].x2, tail.length);
  assert.deepEqual(fallbackLinksTouching(rows, 2), links);
});

test("rastreamento de mouse: clique puro vai ao programa; Ctrl+clique abre e não é reportado", () => {
  const plain = { ctrl: false, meta: false, shift: false };
  const ctrl = { ctrl: true, meta: false, shift: false };
  const shift = { ctrl: false, meta: false, shift: true };
  assert.equal(shouldActivateLink(false, plain), true);
  assert.equal(shouldActivateLink(true, plain), false);
  assert.equal(shouldActivateLink(true, ctrl), true);
  assert.equal(shouldActivateLink(true, shift), false);
  assert.equal(shouldActivateLink(false, shift), false);
  assert.equal(suppressAppMouseDown(true, ctrl), true);
  assert.equal(suppressAppMouseDown(true, plain), false);
  assert.equal(suppressAppMouseDown(false, ctrl), false);
  assert.match(linkHoverHint(true, "open"), /Ctrl\+clique para abrir/);
  assert.match(linkHoverHint(false, "http"), /^Clique para abrir no navegador$/);
  assert.match(linkHoverHint(true, "reveal"), /mostrar na pasta/);
});

// Sem DOM: o gesto no xterm é conferido lendo o componente, como links.test.ts.
test("TerminalView: Ctrl+clique abre, a dica aparece e o clique puro segue para o programa", () => {
  const src = fs.readFileSync("src/components/TerminalView.tsx", "utf8");
  assert.match(src, /shouldActivateLink/);
  assert.match(src, /suppressAppMouseDown/);
  assert.match(src, /linkHoverHint/);
  assert.match(src, /xterm-hover/);
  assert.match(src, /\/api\/local-file\/open-default/);
  assert.match(src, /\/api\/local-file\/reveal/);
});

test("pasta solta: caminho absoluto sem extensão vira link de pasta; falsos positivos ficam de fora", () => {
  const got = (s: string) => extractFolderCandidates(s).map((c) => c.uri);
  assert.deepEqual(got("estão em /mcut-video-data/lpr/50-controle/conferencia-2026-10-15/"), ["/mcut-video-data/lpr/50-controle/conferencia-2026-10-15/"]);
  assert.deepEqual(got("veja (/mnt/data/repo)."), ["/mnt/data/repo"]);
  assert.deepEqual(got("em ~/projetos/app"), ["~/projetos/app"]);
  assert.deepEqual(got("pasta C:/dados/export agora"), ["C:/dados/export"]);
  // uma barra só, sem barra no fim: comando de barra, não pasta
  assert.deepEqual(got("use /compact e /model"), []);
  assert.deepEqual(got("e/ou a/b/c e 10/15/2026"), []);
  assert.deepEqual(got("https://example.com/a/b/c"), []);
  assert.deepEqual(got("arquivo /mnt/data/x.md"), []); // com extensão é arquivo
  assert.deepEqual(got("raiz /mnt/"), ["/mnt/"]);
  // o fallback junta arquivos e pastas na mesma linha
  const row = "veja /mnt/data/x.md e /mnt/data/pasta/";
  const kinds = rowLinkCandidates(row).map((c) => c.uri);
  assert.deepEqual(kinds, ["/mnt/data/x.md", "/mnt/data/pasta/"]);
});

test("pasta: no pane WSL abre a pasta do WSL no Windows; no pane Windows, Linux não é clicável", () => {
  const ctx = { paneKind: "wsl", paneWsl: true, paneDistro: "Ubuntu" };
  const unc = ["", "", "wsl.localhost", "Ubuntu", "mnt", "data", "lpr"].join(String.fromCharCode(92));
  assert.deepEqual(routeTermLink("/mnt/data/lpr/", ctx), { kind: "folder", path: unc });
  assert.deepEqual(routeTermLink("/mnt/data/lpr", ctx), { kind: "folder", path: unc });
  assert.equal(routeTermLink("/mnt/data/lpr/", { paneKind: "powershell" }), null);
  assert.deepEqual(routeTermLink("C:/dados/export", { paneKind: "powershell" }), { kind: "folder", path: "C:" + String.fromCharCode(92) + "dados" + String.fromCharCode(92) + "export" });
  assert.match(linkHoverHint(false, "folder"), /abrir a pasta no Explorer/);
});
