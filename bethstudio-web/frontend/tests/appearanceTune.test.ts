import { test } from "node:test";
import assert from "node:assert/strict";
import { applyGlassPatch, applyVibrancyClick, clampGlass, glassSlidersVisible, nextVibrancy, shellVibrancyOn, shownVibrancy, vibrancyClick, vibrancyShownAfterSave } from "../src/lib/appearanceTune.ts";
import { rightSlot, sideFrame } from "../src/lib/sidebarFrame.ts";

test("o botão de vibrancy liga e o seguinte desliga", () => {
  // O clique que o botão envia, do desligado ao ligado e de volta.
  const first = vibrancyClick(false);
  assert.equal(first.next, true);
  assert.equal(first.storage, "1");
  const second = vibrancyClick(first.next);
  assert.equal(second.next, false);
  assert.equal(second.storage, "0");
  const alreadyOn = vibrancyClick(true);
  assert.equal(alreadyOn.next, false);
  assert.equal(vibrancyClick(alreadyOn.next).next, true);

  // Clique real: liga, a API devolve vibrancy true, pending limpo.
  const turnedOn = applyVibrancyClick(false, { vibrancy: true });
  assert.equal(turnedOn.posted, true);
  assert.equal(turnedOn.pendingCleared, true);
  assert.equal(turnedOn.localStorage, "1");
  assert.equal(turnedOn.shown, true);

  // O JSON antigo omitia false. O clique posta false, o pending é limpo,
  // o localStorage ainda pode estar "1", e o shell não religa. O objeto
  // abaixo é o formato real da resposta: o campo não existe.
  const omittedTheme: { mode: string; glass?: number; glass_alpha?: number; vibrancy?: boolean } = {
    mode: "follow",
    glass: 88,
    glass_alpha: 100,
  };
  assert.equal(Object.prototype.hasOwnProperty.call(omittedTheme, "vibrancy"), false);
  const click = vibrancyClick(true);
  assert.equal(click.next, false);
  assert.equal(click.storage, "0");
  const omitted = applyVibrancyClick(true, omittedTheme);
  assert.equal(omitted.posted, false);
  assert.equal(omitted.pendingCleared, true);
  assert.equal(omitted.shown, false);
  assert.equal(vibrancyShownAfterSave(omittedTheme, true), false);
  // O botão, com o pending já limpo, usa vibrancyShownAfterSave. O shell
  // usa shellVibrancyOn. Os dois têm de ficar desligados se o false foi
  // omitido e o localStorage ainda diz "1".
  const buttonAfterResponse = vibrancyShownAfterSave(omittedTheme, true);
  const shellAfterLoad = shellVibrancyOn(omittedTheme, true, true);
  assert.equal(buttonAfterResponse, false);
  assert.equal(shellAfterLoad, false);
  if (buttonAfterResponse || shellAfterLoad) {
    throw new Error("desligado voltou a ligar");
  }

  // false explícito também desliga, e um "1" pendente não ganha dele.
  const explicit = applyVibrancyClick(true, { vibrancy: false });
  assert.equal(explicit.shown, false);
  assert.equal(shownVibrancy(false, true, true), false);
});

test("a amostra segue o valor gravado, inclusive false", () => {
  assert.equal(shownVibrancy(true, null), true);
  assert.equal(shownVibrancy(false, true), false);
  // Antes de carregar, o clique pendente ainda liga. Depois que as
  // configurações chegaram, campo ausente é desligado — o "1" do
  // localStorage não religa.
  assert.equal(shownVibrancy(undefined, true, false), true);
  assert.equal(shownVibrancy(undefined, true, true), false);
  assert.equal(shownVibrancy(null, false, true), false);
  assert.equal(shownVibrancy(undefined, null, true), false);
});

test("os sliders gravam na faixa 15–100 e um não apaga o outro", () => {
  const start = { glass: 55, glass_alpha: 70 };
  const power = applyGlassPatch(start, { glass: 40 });
  assert.equal(power.glass, 40);
  assert.equal(power.glass_alpha, 70);
  const alpha = applyGlassPatch(power, { glass_alpha: 90 });
  assert.equal(alpha.glass, 40);
  assert.equal(alpha.glass_alpha, 90);
  assert.equal(clampGlass(0), 15);
  assert.equal(clampGlass(140), 100);
  assert.equal(applyGlassPatch(start, { glass: 1 }).glass, 15);
  assert.equal(glassSlidersVisible(true), true);
  assert.equal(glassSlidersVisible(false), false);
});

test("a pasta aberta deixa 8 px até a borda, o terminal e o fundo", () => {
  assert.equal(rightSlot(false), null);
  const slot = rightSlot(true);
  assert.ok(slot);
  assert.equal(slot.edge, 8);
  assert.equal(slot.terminal, 8);
  assert.equal(slot.bottom, 8);
  const frame = sideFrame(900, "rgb(19, 19, 19)");
  assert.equal(frame.bottom, 900 - slot.bottom);
});
