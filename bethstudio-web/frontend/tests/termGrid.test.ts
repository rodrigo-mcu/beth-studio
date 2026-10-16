// Popup "Todos os terminais": cartoes, filtros, busca e o print da tela.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PaneInfo } from "../src/lib/types.ts";
import type { Layout } from "../src/lib/layout.ts";
import { buildCards, countByFilter, facetKindChips, facetStateCounts, filterCards, previewLines, toggleChip } from "../src/lib/termGrid.ts";

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
  assert.equal(by[4].where, "Sem aba — clique para abrir");
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

function typed(id: number, kind: string, extra: Partial<PaneInfo> = {}): PaneInfo {
  return { ...pane(id, extra.title ?? `t${id}`, extra.cwd), kind, ...extra };
}

test("tipo, estado e busca se combinam; encerrado sem info só passa em Todos", () => {
  const panes = [
    typed(1, "wsl", { title: "claude", agent: true, kind_label: "WSL" }),
    typed(2, "pwsh", { title: "vite", kind_label: "PowerShell 7" }),
    typed(3, "powershell", { title: "build", kind_label: "" }),
    typed(4, "bash", { title: "api", kind_label: "bash" }),
  ];
  const lay: Layout = {
    tabs: [
      { id: "a", name: "api", root: leaf(1) },
      { id: "b", name: "web", root: { type: "split", dir: "row", sizes: [1, 1, 1], children: [leaf(2), leaf(3), leaf(9, { gone: true, title: "build antigo" })] } },
    ],
    active: "a",
    closed: [{ id: "c", name: "velha", root: leaf(4) }],
  };
  const cards = buildCards(panes, lay);
  // PowerShell 5.1 e 7 ficam no mesmo chip; bash cai em Outros; encerrado não inventa tipo.
  assert.deepEqual(
    facetKindChips(cards, "all", "").map((c) => [c.id, c.label, c.count]),
    [
      ["all", "Todos", 5],
      ["wsl", "WSL", 1],
      ["powershell", "PowerShell", 2],
      ["other", "Outros", 1],
      ["agent", "Agentes", 1],
    ],
  );
  assert.deepEqual(filterCards(cards, "all", "", undefined, false, "powershell").map((c) => c.pane), [2, 3]);
  assert.deepEqual(filterCards(cards, "gone", "", undefined, false, "powershell").map((c) => c.pane), []);
  assert.deepEqual(filterCards(cards, "gone", "", undefined, false, "all").map((c) => c.pane), [9]);
  assert.deepEqual(filterCards(cards, "tab", "claude", undefined, false, "agent").map((c) => c.pane), [1]);
  assert.deepEqual(filterCards(cards, "hidden", "", undefined, false, "other").map((c) => c.pane), [4]);
});

test("contagens de cada fileira ignoram o próprio filtro e respeitam os outros", () => {
  const panes = [typed(1, "wsl", { title: "claude", agent: true }), typed(2, "cmd", { title: "vite" }), typed(3, "serial", { title: "com3", kind_label: "Serial · COM3" })];
  const lay: Layout = {
    tabs: [{ id: "a", name: "api", root: { type: "split", dir: "row", sizes: [1, 1], children: [leaf(1), leaf(9, { gone: true, title: "velho" })] } }],
    active: "a",
    closed: [{ id: "c", name: "velha", root: leaf(2) }],
  };
  const cards = buildCards(panes, lay);
  // estado "gone" não reduz o chip Encerrados; tipo "wsl" reduz.
  assert.deepEqual(facetStateCounts(cards, "all", ""), { all: 4, tab: 1, hidden: 2, gone: 1 });
  assert.deepEqual(facetStateCounts(cards, "wsl", ""), { all: 1, tab: 1, hidden: 0, gone: 0 });
  assert.deepEqual(facetStateCounts(cards, "all", "vite"), { all: 1, tab: 0, hidden: 1, gone: 0 });
  // tipo selecionado não zera os outros tipos; estado "hidden" e a busca entram.
  assert.deepEqual(
    facetKindChips(cards, "hidden", "", undefined, false, ["serial", "wsl"], "wsl").map((c) => [c.id, c.count]),
    [
      ["all", 2],
      ["serial", 1],
      ["wsl", 0],
      ["cmd", 1],
    ],
  );
  assert.deepEqual(
    facetKindChips(cards, "all", "claude", undefined, false, undefined, "wsl").map((c) => [c.id, c.label, c.count]),
    [
      ["all", "Todos", 1],
      ["wsl", "WSL", 1],
      ["agent", "Agentes", 1],
    ],
  );
});

test("chip de tipo já escolhido volta para Todos; kind_label vazio não cria chip", () => {
  assert.equal(toggleChip("wsl", "wsl", "all"), "all");
  assert.equal(toggleChip("all", "serial", "all"), "serial");
  assert.equal(toggleChip("gone", "gone", "all"), "all");
  assert.equal(toggleChip("tab", "all", "all"), "all");
  const cards = buildCards([typed(1, "ssh", { kind_label: "", ssh_host: "web" })], { tabs: [{ id: "a", name: "api", root: leaf(1) }], active: "a" });
  assert.deepEqual(
    facetKindChips(cards, "all", "").map((c) => [c.id, c.label, c.count]),
    [
      ["all", "Todos", 1],
      ["ssh", "SSH", 1],
    ],
  );
});

test("previewLines: ultimas linhas com texto, sem escapes", () => {
  const raw = "\x1b[32mone\x1b[0m\n\n   \ntwo  \nthree\nfour";
  assert.deepEqual(previewLines(raw, 3), ["two", "three", "four"]);
  assert.deepEqual(previewLines(undefined), []);
  assert.equal(previewLines("x".repeat(200), 1, 10)[0].length, 10);
});

test("terminal sozinho na aba leva o nome da aba; em aba dividida vale o título do terminal", () => {
  const panes = [typed(1, "wsl", { title: "claude" }), typed(2, "cmd", { title: "vite" }), typed(3, "cmd", { title: "npm" })];
  const lay: Layout = {
    tabs: [
      { id: "a", name: "CLIENTE", root: leaf(1) },
      { id: "b", name: "dupla", root: { type: "split", dir: "row", sizes: [1, 1], children: [leaf(2), leaf(3)] } },
    ],
    active: "a",
  };
  const cards = buildCards(panes, lay);
  assert.deepEqual(cards.map((c) => c.title), ["CLIENTE", "vite", "npm"]);
  // a busca ainda acha pelo título do terminal
  assert.deepEqual(filterCards(cards, "all", "claude").map((c) => c.pane), [1]);
});
