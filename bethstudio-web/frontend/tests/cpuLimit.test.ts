import { test } from "node:test";
import assert from "node:assert/strict";
import { chipText, percentHint, statusText, type CpuLimit } from "../src/lib/cpuLimit.ts";

const base: CpuLimit = { percent: 0, until: 0, wsl: true, total: 24, wsl_cores: 0, applied_win: 0, applied_wsl: 0 };

test("texto do botão", () => {
  assert.equal(chipText(base), "");
  assert.equal(chipText({ ...base, percent: 70 }), "CPU 70%");
  const until = new Date(2026, 10, 21, 23, 5).getTime() / 1000;
  assert.equal(chipText({ ...base, percent: 70, until }), "CPU 70% · até 23:05");
});

test("equivalência em núcleos", () => {
  assert.equal(percentHint(70, 24), "70% da CPU ≈ 17 de 24 núcleos");
  assert.equal(percentHint(5, 4), "5% da CPU ≈ 1 de 4 núcleos");
});

test("estado", () => {
  assert.match(statusText(base), /Sem limite/);
  assert.match(statusText({ ...base, restore: true }), /Voltando/);
  const s = statusText({ ...base, percent: 50, applied_win: 1, applied_wsl: 40, wsl_cores: 12 }, "windows");
  assert.match(s, /No máximo 50% da CPU, até você remover/);
  assert.match(s, /1 processo no Windows, 40 no WSL \(12 núcleos\)/);
  assert.doesNotMatch(statusText({ ...base, percent: 50, wsl: false }, "windows"), /WSL/);
  assert.match(statusText({ ...base, percent: 50, applied_win: 3 }, "mac"), /3 processos com prioridade reduzida no Mac/);
});
