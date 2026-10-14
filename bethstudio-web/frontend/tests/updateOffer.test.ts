import { test } from "node:test";
import assert from "node:assert/strict";
import { safeReleaseURL, updateButtons, type UpdateCheck } from "../src/lib/updateOffer.ts";

function check(over: Partial<UpdateCheck> = {}): UpdateCheck {
  return {
    current: "0.1.0",
    latest: "0.2.0",
    update: true,
    can_install: true,
    ui_available: true,
    ui_already: false,
    setup_available: true,
    message: "Há a versão 0.2.0.",
    html_url: "https://github.com/rodrigo-mcu/beth-studio/releases/tag/v0.2.0",
    ...over,
  };
}

test("sem versão nova não oferece instalação", () => {
  const b = updateButtons(check({ update: false }), true);
  assert.equal(b.showUI, false);
  assert.equal(b.showSetup, false);
});

test("versão nova no Studio deste computador oferece as duas opções", () => {
  const b = updateButtons(check(), true);
  assert.equal(b.showUI, true);
  assert.equal(b.showSetup, true);
});

test("somente leitura e navegador remoto só avisam", () => {
  assert.deepEqual(updateButtons(check({ can_install: false }), true), { showUI: false, showSetup: false });
  assert.deepEqual(updateButtons(check(), false), { showUI: false, showSetup: false });
});

test("interface já instalada não repete o botão da interface", () => {
  const b = updateButtons(check({ ui_already: true }), true);
  assert.equal(b.showUI, false);
  assert.equal(b.showSetup, true);
});

test("link do release só no repositório oficial", () => {
  assert.equal(safeReleaseURL("https://github.com/rodrigo-mcu/beth-studio/releases/tag/v0.2.0"), "https://github.com/rodrigo-mcu/beth-studio/releases/tag/v0.2.0");
  assert.equal(safeReleaseURL("https://github.com/rodrigo-mcu/beth-studio/releases/tag/v0.2.0-rc.1"), "https://github.com/rodrigo-mcu/beth-studio/releases/tag/v0.2.0-rc.1");
  assert.equal(safeReleaseURL("https://example.com/BethStudio-Setup.exe"), null);
  assert.equal(safeReleaseURL("https://github.com/outro/beth-studio/releases/tag/v0.2.0"), null);
  assert.equal(safeReleaseURL("javascript:alert(1)"), null);
  assert.equal(safeReleaseURL(undefined), null);
});
