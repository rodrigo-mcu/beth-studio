import { test } from "node:test";
import assert from "node:assert/strict";
import { fitSize, needsReencode, pastedImages } from "../src/phone/imageFit.ts";

test("fitSize reduz o lado maior para 2560", () => {
  assert.deepEqual(fitSize(4032, 3024), { w: 2560, h: 1920 });
  assert.deepEqual(fitSize(1170, 2532), { w: 1170, h: 2532 });
  assert.deepEqual(fitSize(1290, 2796), { w: 1181, h: 2560 });
});

test("needsReencode", () => {
  assert.equal(needsReencode("image/heic", 100, 10, 10), true);
  assert.equal(needsReencode("image/png", 400_000, 1170, 2532), false);
  assert.equal(needsReencode("image/png", 3_000_000, 1170, 2532), true);
  assert.equal(needsReencode("image/jpeg", 200_000, 4032, 3024), true);
  assert.equal(needsReencode("image/gif", 5_000_000, 400, 400), false);
});

test("pastedImages: imagem colada vira anexo; texto não", () => {
  const png = new File([new Uint8Array([1])], "print.png", { type: "image/png" });
  const item = (kind: string, type: string, f: File | null) => ({ kind, type, getAsFile: () => f });
  assert.deepEqual(pastedImages({ items: [item("string", "text/plain", null), item("file", "image/png", png)] }), [png]);
  assert.deepEqual(pastedImages({ items: [item("string", "text/plain", null)] }), []);
  assert.deepEqual(pastedImages({ items: [], files: [png] }), [png]);
  const pdf = new File([new Uint8Array([1])], "a.pdf", { type: "application/pdf" });
  assert.deepEqual(pastedImages({ items: [item("file", "application/pdf", pdf)] }), []);
});
