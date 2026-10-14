// O xterm headless não tem DOM: dá para ver o modo de mouse, não o clique.
import { test } from "node:test";
import assert from "node:assert/strict";
import xtermHeadless from "@xterm/headless";

const { Terminal } = xtermHeadless;

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, () => resolve()));
}

test("DECSET 1000 liga o rastreamento vt200 e 1000l desliga", async () => {
  const term = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
  assert.equal(term.modes.mouseTrackingMode, "none");
  await write(term, "\x1b[?1000h");
  assert.equal(term.modes.mouseTrackingMode, "vt200");
  await write(term, "\x1b[?1000l");
  assert.equal(term.modes.mouseTrackingMode, "none");
  term.dispose();
});
