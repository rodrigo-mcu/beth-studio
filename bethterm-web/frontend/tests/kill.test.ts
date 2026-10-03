// Garantia do usuario: fechar aba / visualizacao / tirar da organizacao
// NUNCA encerra o terminal. So' "Encerrar terminal…" confirmado manda kill.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { addTab, closeTab, detachPane, emptyLayout, leaves, movePaneToTab, removeLeafAt } from "../src/lib/layout.ts";
import { killConfirmed } from "../src/lib/killFlow.ts";

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

test("so' lib/killFlow.ts manda kill (e so' o modal de confirmacao chama killConfirmed)", () => {
  const src = path.resolve("src");
  const files = walk(src);
  const killCallers = files.filter((f) => /\.kill\(/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(src, f).replace(/\\/g, "/"));
  assert.deepEqual(killCallers, ["lib/killFlow.ts"]);
  const confirmCallers = files
    .filter((f) => !f.endsWith("killFlow.ts") && /killConfirmed\(/.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(src, f).replace(/\\/g, "/"));
  assert.deepEqual(confirmCallers, ["components/KillDialog.tsx"]);
  const op = files.filter((f) => /op: "kill"/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(src, f).replace(/\\/g, "/"));
  assert.deepEqual(op, ["lib/connection.ts"]);
});

test("fechar aba / tirar da organizacao so' mudam o layout do web", () => {
  let l = emptyLayout();
  l = movePaneToTab(l, 5, l.active);
  l = addTab(l, "", 6);
  const calls: number[] = [];
  const spy = { kill: (p: number) => (calls.push(p), true) } as never;
  l = closeTab(l, l.active); // aba com o 6
  l = detachPane(l, 5);
  l = removeLeafAt(l, l.tabs[0].id, []);
  assert.equal(leaves(l.tabs[0].root).length, 0);
  assert.deepEqual(calls, []); // nenhuma dessas acoes encerra nada
  killConfirmed(spy, 5); // so' a confirmacao explicita
  assert.deepEqual(calls, [5]);
});
