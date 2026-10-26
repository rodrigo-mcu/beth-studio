// A escrita incremental (createScreenWriter) tem de deixar o xterm IDENTICO a
// escrita completa (screenWrite), celula a celula, mesmo com o host emitindo
// cada linha RELATIVA ao estado SGR/hyperlink em que a linha anterior terminou
// (lines_to_escapes em upstream-wezterm/lua-api-crates/termwiz-funcs).
import { test } from "node:test";
import assert from "node:assert/strict";
import headless from "@xterm/headless";
import { createScreenWriter, screenWrite, tailAfter } from "../src/lib/screen.ts";

const { Terminal } = headless;
type Term = InstanceType<typeof Terminal>;

const ESC = "\x1b";
const COLS = 24;
const ROWS = 7;

// --- gerador pseudo-aleatorio reproduzivel ----------------------------------
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

interface Attr {
  fg: number; // 0 = padrao, 1..7 = 30+n, 8 = truecolor
  bg: number;
  bold: boolean;
  inverse: boolean;
  underline: boolean;
  link: string;
}
interface Cell {
  ch: string;
  a: Attr;
}
const BLANK: Attr = { fg: 0, bg: 0, bold: false, inverse: false, underline: false, link: "" };
const same = (x: Attr, y: Attr) => x.fg === y.fg && x.bg === y.bg && x.bold === y.bold && x.inverse === y.inverse && x.underline === y.underline && x.link === y.link;

function fgSeq(n: number): string {
  if (n === 0) return "39";
  if (n === 8) return "38;2;10;200;90";
  return String(30 + n);
}
function bgSeq(n: number): string {
  if (n === 0) return "49";
  if (n === 8) return "48;2;200;40;40";
  return String(40 + n);
}
function absSeq(a: Attr): string {
  const p = ["0"];
  if (a.bold) p.push("1");
  if (a.underline) p.push("4");
  if (a.inverse) p.push("7");
  if (a.fg) p.push(fgSeq(a.fg));
  if (a.bg) p.push(bgSeq(a.bg));
  return `${ESC}[${p.join(";")}m`;
}
function link(url: string): string {
  return `${ESC}]8;;${url}${ESC}\\`;
}

/** Transicao de `cur` para `to`, como o termwiz: as vezes absoluta, as vezes delta. */
function transition(cur: Attr, to: Attr, r: () => number): string {
  let out = "";
  if (cur.link !== to.link) out += link(to.link);
  const sgrDiff = cur.fg !== to.fg || cur.bg !== to.bg || cur.bold !== to.bold || cur.inverse !== to.inverse || cur.underline !== to.underline;
  if (!sgrDiff) return out;
  if (r() < 0.4) return out + absSeq(to);
  const p: string[] = [];
  if (cur.bold !== to.bold) p.push(to.bold ? "1" : "22");
  if (cur.underline !== to.underline) p.push(to.underline ? "4" : "24");
  if (cur.inverse !== to.inverse) p.push(to.inverse ? "7" : "27");
  if (cur.fg !== to.fg) p.push(fgSeq(to.fg));
  if (cur.bg !== to.bg) p.push(bgSeq(to.bg));
  // as vezes cada parametro em sua propria sequencia
  return out + (r() < 0.5 ? `${ESC}[${p.join(";")}m` : p.map((x) => `${ESC}[${x}m`).join(""));
}

/** Igual a lines_to_escapes: cada linha parte do estado em que a anterior terminou. */
function hostText(grid: Cell[][], _r: () => number): string {
  let cur = BLANK;
  const lines: string[] = [];
  for (const row of grid) {
    // O host e' deterministico: a mesma linha com o mesmo estado de entrada gera os
    // mesmos bytes. A escolha "absoluto ou delta" depende so' do conteudo da linha.
    const r = rng(hash(JSON.stringify(row) + JSON.stringify(cur)));
    let s = "";
    for (const c of row) {
      s += transition(cur, c.a, r);
      cur = c.a;
      s += c.ch;
    }
    // Rust: o estado carregado so' muda se a linha tem celulas visiveis
    lines.push(s);
  }
  return lines.join("\r\n");
}

function randAttr(r: () => number): Attr {
  if (r() < 0.45) return BLANK;
  return {
    fg: Math.floor(r() * 9),
    bg: r() < 0.7 ? 0 : Math.floor(r() * 9),
    bold: r() < 0.3,
    inverse: r() < 0.15,
    underline: r() < 0.15,
    link: r() < 0.15 ? "https://exemplo.test/x" : "",
  };
}

function randRow(r: () => number): Cell[] {
  const len = r() < 0.15 ? 0 : Math.floor(r() * (COLS + 1)); // linhas vazias e curtas existem
  const row: Cell[] = [];
  let a = randAttr(r);
  for (let i = 0; i < len; i++) {
    if (r() < 0.25) a = randAttr(r);
    row.push({ ch: "abcdefgXYZ-=_#"[Math.floor(r() * 14)], a });
  }
  return row;
}

function snapshot(t: Term): string[] {
  const out: string[] = [];
  for (let y = 0; y < t.rows; y++) {
    const line = t.buffer.active.getLine(y)!;
    let s = "";
    for (let x = 0; x < t.cols; x++) {
      const c = line.getCell(x)!;
      s += `[${c.getChars() || " "}|${c.getFgColorMode()}:${c.getFgColor()}|${c.getBgColorMode()}:${c.getBgColor()}|${c.isBold()}${c.isInverse()}${c.isUnderline()}${c.isDim()}]`;
    }
    out.push(s);
  }
  return out;
}

function newTerm(): Term {
  return new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true });
}
const write = (t: Term, d: string) => new Promise<void>((res) => t.write(d, res));

async function run(seed: number, frames: number) {
  const r = rng(seed);
  const a = newTerm();
  const b = newTerm();
  const w = createScreenWriter();
  let grid: Cell[][] = Array.from({ length: ROWS }, () => randRow(r));
  let bytesFull = 0;
  let bytesDiff = 0;
  for (let f = 0; f < frames; f++) {
    // poucas linhas mudam na maioria dos quadros; de vez em quando muda tudo
    if (r() < 0.08) grid = Array.from({ length: ROWS }, () => randRow(r));
    else {
      const n = 1 + Math.floor(r() * 2);
      for (let k = 0; k < n; k++) grid[Math.floor(r() * ROWS)] = randRow(r);
    }
    const ev = { text: hostText(grid, r), cursor_x: Math.floor(r() * COLS), cursor_y: Math.floor(r() * ROWS), cursor_visible: r() < 0.7, rows: ROWS, cols: COLS };
    const fullData = screenWrite(ev);
    const diffData = w.write(ev);
    bytesFull += fullData.length;
    bytesDiff += diffData.length;
    await write(a, fullData);
    await write(b, diffData);
    const sa = snapshot(a);
    const sb = snapshot(b);
    for (let y = 0; y < ROWS; y++) assert.equal(sb[y], sa[y], `seed=${seed} quadro=${f} linha=${y} diverge da escrita completa`);
    assert.equal(b.buffer.active.cursorX, a.buffer.active.cursorX, `seed=${seed} quadro=${f} cursorX`);
    assert.equal(b.buffer.active.cursorY, a.buffer.active.cursorY, `seed=${seed} quadro=${f} cursorY`);
  }
  return { bytesFull, bytesDiff };
}

test("incremental == completo, celula a celula (SGR relativo entre linhas + hyperlinks)", async () => {
  let full = 0;
  let diff = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const r = await run(seed, 70);
    full += r.bytesFull;
    diff += r.bytesDiff;
  }
  // nao e' so' correto: tem de mandar menos dados. Neste teste o estado SGR muda
  // o tempo todo e uma linha alterada arrasta a seguinte (codificacao relativa do
  // host), entao a economia e' modesta; em tela real (poucas linhas mudam) e' maior.
  assert.ok(diff < full * 0.8, `incremental deveria mandar menos bytes (${diff} vs ${full})`);
});

test("quadro igual ao anterior: so' cursor, nenhuma linha reescrita", () => {
  const w = createScreenWriter();
  const ev = { text: ["um", "dois", "tres"].join("\r\n"), cursor_x: 1, cursor_y: 2, cursor_visible: true, rows: 3, cols: 10 };
  w.write(ev);
  const again = w.write(ev);
  assert.ok(!again.includes("2K"), "nenhuma linha deveria ser apagada/reescrita");
  assert.ok(!again.includes("dois"));
});

test("incremental=false: sempre a escrita completa (valvula de escape)", () => {
  const w = createScreenWriter(false);
  const ev = { text: ["um", "dois"].join("\r\n"), cursor_x: 0, cursor_y: 0, cursor_visible: true, rows: 2, cols: 10 };
  assert.equal(w.write(ev), screenWrite(ev));
  assert.equal(w.write(ev), screenWrite(ev), "mesmo quadro de novo continua completo");
});

test("mudou o tamanho ou reset(): escrita completa", () => {
  const w = createScreenWriter();
  const ev = { text: ["a", "b"].join("\r\n"), cursor_x: 0, cursor_y: 0, cursor_visible: true, rows: 2, cols: 10 };
  w.write(ev);
  assert.ok(w.write({ ...ev, cols: 11 }).includes(`${ESC}[2J`), "mudou cols");
  assert.ok(!w.write({ ...ev, cols: 11 }).includes(`${ESC}[2J`));
  w.reset();
  assert.ok(w.write({ ...ev, cols: 11 }).includes(`${ESC}[2J`), "apos reset()");
});

test("hyperlink aberto na ultima linha nao vaza para a linha 0 do quadro seguinte", async () => {
  const t = newTerm();
  const open = `${ESC}]8;;https://a.test${ESC}\\`;
  // quadro 1 termina DENTRO do link (sem fechar); quadro 2 nao tem link nenhum
  await write(t, screenWrite({ text: ["x", `${open}link`].join("\r\n"), cursor_x: 0, cursor_y: 0, cursor_visible: true, rows: 2, cols: COLS }));
  await write(t, screenWrite({ text: ["limpo", "fim"].join("\r\n"), cursor_x: 0, cursor_y: 0, cursor_visible: true, rows: 2, cols: COLS }));
  const c = t.buffer.active.getLine(0)!.getCell(0)!;
  assert.equal(c.isUnderline(), 0, "a linha 0 nao deve herdar o link do quadro anterior");
});

test("tailAfter acompanha reset, delta e hyperlink", () => {
  const t1 = tailAfter({ sgr: "", link: "" }, `${ESC}[1mA${ESC}[31mB`);
  assert.equal(t1.sgr, `${ESC}[1m${ESC}[31m`);
  const t2 = tailAfter(t1, `${ESC}[0mC${ESC}[4mD`);
  assert.equal(t2.sgr, `${ESC}[4m`);
  const t3 = tailAfter(t2, `${ESC}[0;1;32mE`);
  assert.equal(t3.sgr, `${ESC}[0;1;32m`);
  const t4 = tailAfter(t3, `${ESC}]8;;https://a.test${ESC}\\x`);
  assert.equal(t4.link, `${ESC}]8;;https://a.test${ESC}\\`);
  const t5 = tailAfter(t4, `${ESC}]8;;${ESC}\\y`);
  assert.equal(t5.link, "");
});
