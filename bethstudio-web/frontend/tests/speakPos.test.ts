import { test } from "node:test";
import assert from "node:assert/strict";
import { initialPos, isPos, keepInside } from "../src/lib/speakPos.ts";

const VW = 1200;
const VH = 800;

test("sem posição salva: centralizada e perto do alto", () => {
  assert.deepEqual(initialPos(null, 640, 300, VW, VH), { x: 280, y: 64 });
});

test("posição salva é respeitada", () => {
  assert.deepEqual(initialPos({ x: 700, y: 400 }, 400, 300, VW, VH), { x: 700, y: 400 });
});

test("posição salva fora da tela (monitor menor) volta para dentro", () => {
  assert.deepEqual(initialPos({ x: 3000, y: 2000 }, 640, 300, VW, VH), { x: VW - 640, y: VH - 300 });
  assert.deepEqual(initialPos({ x: -50, y: -50 }, 640, 300, VW, VH), { x: 0, y: 0 });
});

test("janela maior que a tela fica em 0,0 em vez de valores negativos", () => {
  assert.deepEqual(keepInside({ x: 100, y: 100 }, 2000, 2000, VW, VH), { x: 0, y: 0 });
});

test("isPos rejeita lixo", () => {
  assert.equal(isPos({ x: 1, y: 2 }), true);
  assert.equal(isPos({ x: 1 }), false);
  assert.equal(isPos({ x: NaN, y: 1 }), false);
  assert.equal(isPos(null), false);
  assert.equal(isPos("x"), false);
});
