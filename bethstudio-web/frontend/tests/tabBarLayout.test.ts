// Barra de abas: acoes sempre so' icone; o menu "…" so' quando nem os icones cabem.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ICON_W, MORE_W, planBarActions, type BarAction } from "../src/lib/tabBarLayout.ts";

const A: BarAction[] = [
  { id: "speak", label: "Falar", priority: 3 },
  { id: "search", label: "Buscar", priority: 4 },
  { id: "tasks", label: "Tarefas", priority: 1 },
  { id: "db", label: "Banco de dados", priority: 0 },
  { id: "settings", label: "Configurações", priority: 9 },
];

test("sempre só ícone, em qualquer largura", () => {
  for (const w of [5000, 1919, 600, ICON_W * A.length]) {
    const p = planBarActions(w, A);
    assert.deepEqual(p.overflow, []);
    assert.ok(p.shown.every((s) => !s.label));
    assert.deepEqual(
      p.shown.map((s) => s.id),
      A.map((a) => a.id),
    );
  }
});

test("nem os ícones cabem: os de menor prioridade vão para o …, Configurações fica", () => {
  const p = planBarActions(ICON_W * 2 + MORE_W, A);
  assert.deepEqual(p.overflow, ["speak", "tasks", "db"]);
  assert.deepEqual(p.shown, [
    { id: "search", label: false },
    { id: "settings", label: false },
  ]);
  const zero = planBarActions(0, A);
  assert.equal(zero.shown.length, 0);
  assert.equal(zero.overflow.length, A.length);
});

test("nunca passa do espaço (vários tamanhos)", () => {
  for (let w = 0; w <= ICON_W * A.length + 50; w += 3) {
    const p = planBarActions(w, A);
    const used = p.shown.length * ICON_W + (p.overflow.length ? MORE_W : 0);
    assert.ok(used <= w || p.shown.length === 0, `w=${w} usou ${used}`);
  }
});

test("barra de título: arraste, botões da janela e ações com tooltip/aria-label", () => {
  const tb = fs.readFileSync("src/components/TabBar.tsx", "utf8");
  assert.match(tb, /onMouseDown=\{startDrag\}/);
  assert.match(tb, /onDoubleClick=\{\(\) => winCommand\("toggle"\)\}/);
  assert.match(tb, /<WindowControls/);
  assert.match(tb, /aria-label=\{a\.label\}/);
  const side = fs.readFileSync("src/components/Sidebar.tsx", "utf8");
  assert.match(side, /<AppTitle( right=\{[^}]*\})? \/>/);
});
