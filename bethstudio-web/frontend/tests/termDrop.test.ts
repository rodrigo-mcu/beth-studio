import { test } from "node:test";
import assert from "node:assert/strict";
import { pointInPage, shouldCloseAfterDrop, toCssPoint } from "../src/lib/termDrop.ts";

test("converte pixel físico em CSS pelo devicePixelRatio", () => {
  assert.deepEqual(toCssPoint(300, 150, 1), { x: 300, y: 150 });
  assert.deepEqual(toCssPoint(300, 150, 1.5), { x: 200, y: 100 });
  assert.deepEqual(toCssPoint(300, 150, 2), { x: 150, y: 75 });
});

test("dpr inválido cai para 1", () => {
  assert.deepEqual(toCssPoint(10, 20, 0), { x: 10, y: 20 });
  assert.deepEqual(toCssPoint(10, 20, NaN), { x: 10, y: 20 });
});

test("ponto fora da página (ou -1 do Go) não conta", () => {
  assert.equal(pointInPage({ x: -1, y: -1 }, 1000, 800), false);
  assert.equal(pointInPage({ x: 1000, y: 10 }, 1000, 800), false);
  assert.equal(pointInPage({ x: 999, y: 799 }, 1000, 800), true);
});

test("só fecha a janela quando o pane entrou no layout", () => {
  assert.equal(shouldCloseAfterDrop(true), true);
  assert.equal(shouldCloseAfterDrop(false), false);
});
