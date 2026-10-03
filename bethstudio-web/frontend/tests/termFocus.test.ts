// Foco volta ao terminal depois do popup "Falar".
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerTerm, returnFocus, withTabFocus } from "../src/lib/termFocus.ts";

test("ativa a aba, espera o popup sair e foca o xterm no fim", async () => {
  const calls: string[] = [];
  const off = registerTerm(5, { focus: () => calls.push("focus"), toEnd: () => calls.push("fim") });
  let rafCb: (() => void) | null = null;
  returnFocus(5, () => calls.push("ativa"), (f) => (rafCb = f));
  assert.deepEqual(calls, ["ativa"]); // nada antes do proximo quadro
  rafCb!();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls, ["ativa", "fim", "focus"]);
  off();
});

test("terminal ainda montando: tenta de novo até aparecer", async () => {
  const calls: string[] = [];
  returnFocus(9, () => calls.push("ativa"), (f) => f());
  await new Promise((r) => setTimeout(r, 60));
  const off = registerTerm(9, { focus: () => calls.push("focus"), toEnd: () => calls.push("fim") });
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(calls, ["ativa", "fim", "focus"]);
  off();
});

test("registro: desmontar tira o terminal; o App devolve o foco ao fechar o Falar", () => {
  const h = { focus: () => undefined, toEnd: () => undefined };
  const off = registerTerm(3, h);
  off();
  const app = fs.readFileSync("src/App.tsx", "utf8");
  assert.match(app, /returnFocus\(/);
  const tv = fs.readFileSync("src/components/TerminalView.tsx", "utf8");
  assert.match(tv, /registerTerm\(paneId/);
});

test("foco por teclado/programa também muda o terminal em foco (ditado não vai para o vizinho)", () => {
  const f0 = { t1: 4 };
  assert.deepEqual(withTabFocus(f0, "t1", 7), { t1: 7 });
  assert.equal(withTabFocus(f0, "t1", 4), f0); // sem mudança: mesmo objeto, sem re-render
  const tv = fs.readFileSync("src/components/TerminalView.tsx", "utf8");
  assert.match(tv, /onFocusCapture=\{onFocus\}/);
  const app = fs.readFileSync("src/App.tsx", "utf8");
  assert.match(app, /withTabFocus\(/);
});
