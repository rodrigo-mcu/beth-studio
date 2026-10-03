import { test } from "node:test";
import assert from "node:assert/strict";
import { fixedFontFor, fontSizeLabel, nextFontSize, smallGridHint } from "../src/lib/fontStep.ts";

test("automatico -> fixo parte do tamanho efetivo arredondado", () => {
  assert.equal(nextFontSize(0, 7.5, +1), 9); // 7,5 arredonda para 8, +1
  assert.equal(nextFontSize(0, 7.4, -1), 6);
  assert.equal(nextFontSize(0, 0, +1), 15); // sem medida: 14
});

test("fixo anda de 1 em 1 dentro de 5..48", () => {
  assert.equal(nextFontSize(13, 99, +1), 14);
  assert.equal(nextFontSize(13, 99, -1), 12);
  assert.equal(nextFontSize(5, 5, -1), 5);
  assert.equal(nextFontSize(48, 48, +1), 48);
  assert.equal(nextFontSize(0, 3.2, -1), 5);
  assert.equal(nextFontSize(0, 60, +1), 48);
});

test("rotulo", () => {
  assert.equal(fontSizeLabel(0), "auto");
  assert.equal(fontSizeLabel(14), "14px");
});

test("Igual ao BethTerm: fonte automatica salvo se fixada NESTE pane", () => {
  assert.equal(fixedFontFor("host", 0, 20), 0); // padrao geral 20 nao vale
  assert.equal(fixedFontFor("host", 16, 20), 16); // fixada no pane
  assert.equal(fixedFontFor("fit", 0, 20), 20);
  assert.equal(fixedFontFor("fit", 0, 0), 14);
  assert.equal(fixedFontFor("fit", 12, 20), 12);
});

test("dica de grid pequeno so' com fonte fixa e < 70% da area", () => {
  assert.equal(smallGridHint(20, 500, 300, 1000, 700), true); // 21%
  assert.equal(smallGridHint(20, 950, 650, 1000, 700), false); // 88%
  assert.equal(smallGridHint(0, 100, 100, 1000, 700), false); // automatica
});
