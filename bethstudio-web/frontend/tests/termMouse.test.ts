import { test } from "node:test";
import assert from "node:assert/strict";
import xtermHeadless from "@xterm/headless";
import { MOUSE_OFF, MOUSE_ON, parseSgrMouse, wantMouse } from "../src/lib/termMouse.ts";

const { Terminal } = xtermHeadless;

test("clique esquerdo: press e release, célula a partir de 0", () => {
  assert.deepEqual(parseSgrMouse("\x1b[<0;10;5M"), [
    { kind: "press", button: "left", x: 9, y: 4, shift: false, alt: false, ctrl: false },
  ]);
  assert.equal(parseSgrMouse("\x1b[<0;10;5m")?.[0].kind, "release");
});

test("arraste, roda e modificadores", () => {
  const drag = parseSgrMouse("\x1b[<32;2;3M")![0];
  assert.equal(drag.kind, "move");
  assert.equal(drag.button, "left");
  assert.equal(parseSgrMouse("\x1b[<64;1;1M")![0].button, "wheel_up");
  assert.equal(parseSgrMouse("\x1b[<65;1;1M")![0].button, "wheel_down");
  const mods = parseSgrMouse("\x1b[<30;1;1M")![0]; // 2 (direito) + 4 + 8 + 16
  assert.equal(mods.button, "right");
  assert.ok(mods.shift && mods.alt && mods.ctrl);
});

test("vários relatos juntos; teclado e lixo não são mouse", () => {
  assert.equal(parseSgrMouse("\x1b[<64;1;1M\x1b[<64;1;1M")?.length, 2);
  assert.equal(parseSgrMouse("a"), null);
  assert.equal(parseSgrMouse("\x1b[A"), null);
  assert.equal(parseSgrMouse("\x1b[<0;1;1Mx"), null);
  assert.equal(parseSgrMouse("\x1b[<0;0;1M"), null);
});

test("só liga com o programa pedindo e na tela viva", () => {
  assert.equal(wantMouse({ mouse: true, offset: 0 }), true);
  assert.equal(wantMouse({ mouse: true }), true);
  assert.equal(wantMouse({ mouse: true, offset: 3 }), false);
  assert.equal(wantMouse({}), false);
});

test("MOUSE_ON liga o rastreamento do xterm e MOUSE_OFF desliga", async () => {
  const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
  await new Promise<void>((r) => term.write(MOUSE_ON, r));
  assert.equal(term.modes.mouseTrackingMode, "drag");
  await new Promise<void>((r) => term.write(MOUSE_OFF, r));
  assert.equal(term.modes.mouseTrackingMode, "none");
  term.dispose();
});
