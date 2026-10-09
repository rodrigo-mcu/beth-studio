// Popup "Todos os terminais": cartoes, filtros, busca e o print da tela.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PaneInfo } from "../src/lib/types.ts";
import type { Layout } from "../src/lib/layout.ts";
import { buildCards, countByFilter, filterCards, previewLines } from "../src/lib/termGrid.ts";

function pane(id: number, title: string, cwd = ""): PaneInfo {
  return {
    window_id: 0,
    tab_id: 0,
    pane_id: id,
    workspace: "default",
    size: { rows: 24, cols: 80 },
    title,
    cwd,
    cursor_x: 0,
    cursor_y: 0,
    tab_title: "",
    window_title: "",
    is_active: false,
    is_zoomed: false,
  };
}

const leaf = (p: number, extra: object = {}) => ({ type: "leaf" as const, pane: p, ...extra });

// aba "api" com #1, aba "web" com #2 e um encerrado #9; aba fechada "velha" com #3; #4 solto
const layout: Layout = {
  tabs: [
    { id: "a", name: "api", root: leaf(1) },
    { id: "b", name: "web", root: { type: "split", dir: "row", sizes: [1, 1], children: [leaf(2), leaf(9, { gone: true, title: "build antigo" })] } },
  ],
  active: "a",
  closed: [{ id: "c", name: "velha", root: leaf(3) }],
};
const panes = [pane(1, "claude", "file:///C:/work/api"), pane(2, "vite", "file:///C:/work/web"), pane(3, "ssh-prod"), pane(4, "powershell", "file:///C:/tmp")];

test("um cartao por terminal: em aba, em aba fechada, solto e encerrado", () => {
  const cards = buildCards(panes, layout);
  const by = Object.fromEntries(cards.map((c) => [c.pane, c]));
  assert.equal(cards.length, 5);
  assert.equal(by[1].state, "tab");
  assert.equal(by[1].tabId, "a");
  assert.equal(by[1].where, "Aba “api”");
  assert.equal(by[3].state, "closed");
  assert.equal(by[3].where, "Aba fechada “velha”");
  assert.equal(by[4].state, "loose");
  assert.equal(by[4].where, "Não organizado");
  assert.equal(by[9].state, "gone");
  assert.equal(by[9].tabId, "b");
  assert.equal(by[9].title, "build antigo");
  // vivos primeiro (ordem das abas), encerrados no fim
  assert.deepEqual(cards.map((c) => c.pane), [1, 2, 3, 4, 9]);
});

test("filtros e contagens", () => {
  const cards = buildCards(panes, layout);
  assert.deepEqual(countByFilter(cards), { all: 5, tab: 2, hidden: 2, gone: 1 });
  assert.deepEqual(filterCards(cards, "hidden", "").map((c) => c.pane), [3, 4]);
  assert.deepEqual(filterCards(cards, "gone", "").map((c) => c.pane), [9]);
});

test("busca por nome, pasta, aba, tipo e #id; todos os termos", () => {
  const cards = buildCards(panes, layout);
  const q = (s: string) => filterCards(cards, "all", s).map((c) => c.pane);
  assert.deepEqual(q("claude"), [1]);
  assert.deepEqual(q("work web"), [2]);
  assert.deepEqual(q("fechada"), [3]);
  assert.deepEqual(q("#4"), [4]);
  assert.deepEqual(q("nada-disso"), []);
});

test("a tela so' entra na busca quando marcado", () => {
  const cards = buildCards(panes, layout);
  const screens = new Map([[2, "ERROR: porta 5173 em uso"]]);
  assert.deepEqual(filterCards(cards, "all", "5173", screens, false), []);
  assert.deepEqual(filterCards(cards, "all", "5173", screens, true).map((c) => c.pane), [2]);
});

test("previewLines: ultimas linhas com texto, sem escapes", () => {
  const raw = "\x1b[32mone\x1b[0m\n\n   \ntwo  \nthree\nfour";
  assert.deepEqual(previewLines(raw, 3), ["two", "three", "four"]);
  assert.deepEqual(previewLines(undefined), []);
  assert.equal(previewLines("x".repeat(200), 1, 10)[0].length, 10);
});
