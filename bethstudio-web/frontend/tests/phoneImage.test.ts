import { test } from "node:test";
import assert from "node:assert/strict";
import { fitSize, needsReencode } from "../src/phone/imageFit.ts";

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
