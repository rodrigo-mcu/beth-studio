import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_WATCH, watchSet } from "../src/lib/watchSet.ts";

test("watchSet: o terminal visível nunca fica de fora, mesmo com muitos agentes", () => {
  const agents = Array.from({ length: 20 }, (_, i) => i);
  const got = watchSet([24], agents);
  assert.equal(got.length, MAX_WATCH);
  assert.ok(got.includes(24));
});

test("watchSet: sem repetir e na ordem visíveis, depois agentes", () => {
  assert.deepEqual(watchSet([5, 3], [3, 1, 2], 4), [5, 3, 1, 2]);
  assert.deepEqual(watchSet([], [], 16), []);
});
