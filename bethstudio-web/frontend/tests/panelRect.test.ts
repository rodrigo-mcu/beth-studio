import { test } from "node:test";
import assert from "node:assert/strict";
import { PANEL_MARGIN, PANEL_MIN_H, PANEL_MIN_W, clampRect, defaultRect, dockRect, isRect, moveRect, resizeRect } from "../src/lib/panelRect.ts";

const VW = 1200;
const VH = 800;

test("posição inicial: canto superior direito", () => {
  assert.deepEqual(defaultRect(680, 600, VW, VH), { x: VW - 680 - PANEL_MARGIN, y: PANEL_MARGIN, w: 680, h: 600 });
});

test("mover não deixa o painel sair da janela", () => {
  const r = { x: 100, y: 100, w: 500, h: 400 };
  assert.deepEqual(moveRect(r, 50, -30, VW, VH), { x: 150, y: 70, w: 500, h: 400 });
  assert.deepEqual(moveRect(r, -999, -999, VW, VH), { x: 0, y: 0, w: 500, h: 400 });
  assert.deepEqual(moveRect(r, 9999, 9999, VW, VH), { x: VW - 500, y: VH - 400, w: 500, h: 400 });
});

test("redimensionar pela borda esquerda mantém a direita parada", () => {
  const r = { x: 400, y: 50, w: 600, h: 300 };
  const out = resizeRect(r, "w", -100, 0, VW, VH);
  assert.equal(out.w, 700);
  assert.equal(out.x + out.w, 1000);
  const small = resizeRect(r, "w", 900, 0, VW, VH);
  assert.equal(small.w, PANEL_MIN_W);
  assert.equal(small.x + small.w, 1000);
});

test("redimensionar pela borda de cima mantém a de baixo parada", () => {
  const r = { x: 400, y: 100, w: 600, h: 300 };
  const out = resizeRect(r, "n", 0, -50, VW, VH);
  assert.equal(out.h, 350);
  assert.equal(out.y + out.h, 400);
  assert.equal(resizeRect(r, "n", 0, 900, VW, VH).h, PANEL_MIN_H);
});

test("direita e baixo não passam da janela; canto mexe nos dois", () => {
  const r = { x: 400, y: 100, w: 600, h: 300 };
  assert.equal(resizeRect(r, "e", 9999, 0, VW, VH).w, VW - 400);
  assert.equal(resizeRect(r, "s", 0, 9999, VW, VH).h, VH - 100);
  const c = resizeRect(r, "se", 20, 30, VW, VH);
  assert.deepEqual({ w: c.w, h: c.h }, { w: 620, h: 330 });
  const nw = resizeRect(r, "nw", -20, -10, VW, VH);
  assert.deepEqual(nw, { x: 380, y: 90, w: 620, h: 310 });
});

test("encostar numa lateral usa a altura toda", () => {
  const r = { x: 300, y: 200, w: 500, h: 300 };
  assert.deepEqual(dockRect("left", r, VW, VH), { x: PANEL_MARGIN, y: PANEL_MARGIN, w: 500, h: VH - 2 * PANEL_MARGIN });
  assert.deepEqual(dockRect("right", r, VW, VH), { x: VW - 500 - PANEL_MARGIN, y: PANEL_MARGIN, w: 500, h: VH - 2 * PANEL_MARGIN });
});

test("janela menor que o painel: encolhe e volta para dentro", () => {
  const c = clampRect({ x: 900, y: 700, w: 680, h: 600 }, 800, 600);
  assert.ok(c.x >= 0 && c.x + c.w <= 800 && c.y >= 0 && c.y + c.h <= 600);
});

test("isRect valida o que vem do localStorage", () => {
  assert.equal(isRect({ x: 1, y: 2, w: 3, h: 4 }), true);
  assert.equal(isRect({ x: 1, y: 2, w: 3 }), false);
  assert.equal(isRect({ x: 1, y: 2, w: "3", h: 4 }), false);
  assert.equal(isRect(null), false);
});
