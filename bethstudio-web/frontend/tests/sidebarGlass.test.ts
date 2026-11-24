import { test } from "node:test";
import assert from "node:assert/strict";
import { glassPlateFields, nativeGlassPlates, wantsNativeGlassPlate } from "../src/lib/sidebarFrame.ts";

// Marcação real da barra: cabeçalho de pasta, linha de terminal, chip,
// campo de busca e botão de modo. O seletor é o mesmo que App.tsx usa
// antes de postar bethGlass.

function plate(className: string): boolean {
  return wantsNativeGlassPlate(className);
}

test("chat selecionado e solto viram placa sem rótulo; pasta e chip não", () => {
  const selected = "bt-chat bt-glass-on group flex min-h-9 cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5";
  const plain = "bt-chat group flex min-h-9 cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5";
  const on = glassPlateFields(selected, "Cursor");
  const off = glassPlateFields(plain, "copper-lang");
  assert.ok(on);
  assert.ok(off);
  assert.equal(on.row, 1);
  assert.equal(off.row, 1);
  assert.equal(on.selected, true);
  assert.equal(off.selected, false);
  assert.equal(on.label, "Cursor");
  assert.equal(off.label, "copper-lang");
  assert.equal(glassPlateFields("bt-folder flex w-full", "brian"), null);
  assert.equal(glassPlateFields("bt-chip rounded-lg", "Todos"), null);
  const posted = nativeGlassPlates(true, [
    { className: selected },
    { className: plain },
    { className: "bt-folder flex w-full" },
    { className: "bt-chip rounded-lg" },
    { className: "bt-folder flex w-full" },
    { className: "bt-search flex items-center" },
  ]);
  assert.equal(posted.some((el) => el.className.includes("bt-folder")), false);
  assert.equal(posted.some((el) => el.className.includes("bt-chip")), false);
});

test("com vibrancy, a pasta não vira placa; chip, chat, busca e modo viram", () => {
  const folder = "bt-folder flex w-full min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[13px] font-semibold text-text-1 hover:bg-bg-hover";
  const row = "bt-chat group flex min-h-9 cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5";
  const rowOn = "bt-chat bt-glass-on group flex min-h-9 cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5";
  const chip = "bt-chip flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11px]";
  const chipOn = "bt-chip bt-glass-on rounded-lg px-2 py-0.5 text-[11px]";
  const search = "bt-search flex items-center gap-1.5 rounded-2xl bg-bg-hover/70 px-3";
  const mode = "bt-mode bt-glass flex min-h-16 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 text-[11px] leading-tight";
  const modeOn = "bt-mode bt-glass bt-glass-on flex min-h-16 bg-accent text-white";
  const icon = "bt-glass inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-2";

  assert.equal(plate(folder), false);
  assert.equal(plate(row), true);
  assert.equal(plate(rowOn), true);
  assert.equal(plate(chip), false);
  assert.equal(plate(chipOn), false);
  assert.equal(plate(search), true);
  assert.equal(plate(mode), true);
  assert.equal(plate(modeOn), true);
  assert.equal(plate(icon), true);
  assert.equal(plate("bt-tab"), true);
  assert.equal(plate("bt-tab-tool"), true);
  assert.equal(plate("bt-glass-sample"), true);
});

test("sem vibrancy a página não pede placa nenhuma", () => {
  const markup = [
    { className: "bt-folder flex w-full" },
    { className: "bt-chat group flex min-h-9" },
    { className: "bt-chip bt-glass-on rounded-lg" },
    { className: "bt-search flex items-center" },
    { className: "bt-mode bt-glass flex min-h-16" },
    { className: "bt-glass inline-flex h-7 w-7" },
  ];
  const off = nativeGlassPlates(false, markup);
  assert.deepEqual(off, []);
  const posted = JSON.stringify(off);
  assert.equal(posted, "[]");
  const on = nativeGlassPlates(true, markup).map((el) => el.className);
  assert.deepEqual(on, [
    "bt-chat group flex min-h-9",
    "bt-search flex items-center",
    "bt-mode bt-glass flex min-h-16",
    "bt-glass inline-flex h-7 w-7",
  ]);
});
