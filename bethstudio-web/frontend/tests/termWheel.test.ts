import { test } from "node:test";
import assert from "node:assert/strict";
import { wheelGoesToApp } from "../src/lib/termWheel.ts";

test("TUI em tela cheia com mouse ligado e sem histórico: a roda vai para o programa", () => {
  assert.equal(wheelGoesToApp({ tracking: true, scrollback: 0 }), true);
});

test("com histórico no host a roda continua rolando o histórico", () => {
  assert.equal(wheelGoesToApp({ tracking: true, scrollback: 500 }), false);
});

test("sem rastreamento de mouse a roda rola o histórico, como sempre", () => {
  assert.equal(wheelGoesToApp({ tracking: false, scrollback: 0 }), false);
  assert.equal(wheelGoesToApp({ tracking: false, scrollback: 500 }), false);
});
