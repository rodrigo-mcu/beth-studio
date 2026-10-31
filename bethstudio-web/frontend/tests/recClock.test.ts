import { test } from "node:test";
import assert from "node:assert/strict";
import { RecClock } from "../src/lib/recClock.ts";

test("sem pausa, conta o tempo corrido", () => {
  const c = new RecClock(1000);
  assert.equal(c.elapsed(1000), 0);
  assert.equal(c.elapsed(4000), 3000);
  assert.equal(c.paused, false);
});

test("pausado congela e o tempo pausado não entra na conta", () => {
  const c = new RecClock(0);
  c.pause(2000);
  assert.equal(c.paused, true);
  assert.equal(c.elapsed(2000), 2000);
  assert.equal(c.elapsed(9000), 2000); // congelado
  c.resume(9000);
  assert.equal(c.paused, false);
  assert.equal(c.elapsed(10000), 3000); // 2 s antes + 1 s depois
});

test("várias pausas somam e pausar/continuar repetido é inofensivo", () => {
  const c = new RecClock(0);
  c.pause(1000);
  c.pause(1500); // segunda chamada não muda o instante da pausa
  c.resume(3000);
  c.resume(3500); // continuar sem estar pausado não faz nada
  c.pause(4000);
  c.resume(6000);
  assert.equal(c.elapsed(7000), 1000 + 1000 + 1000); // [0-1000] + [3000-4000] + [6000-7000]
});
