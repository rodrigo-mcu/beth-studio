import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLIP_LEVEL,
  DEFAULT_TUNING,
  PeakHold,
  dbToGain,
  formatGainDb,
  formatLevelDb,
  gainToDb,
  isMicTuning,
  levelHint,
  normalizeTuning,
  peakOf,
  rmsOfFloat,
} from "../src/lib/micTuning.ts";
import { audioConstraints } from "../src/lib/mic.ts";

test("ganho em dB: 0 dB = x1, +6 dB ~ x2, e a faixa é limitada", () => {
  assert.equal(dbToGain(0), 1);
  assert.ok(Math.abs(dbToGain(6) - 1.995) < 0.01);
  assert.equal(gainToDb(1), 0);
  assert.equal(gainToDb(dbToGain(-12)), -12);
  assert.equal(gainToDb(1000), 12);
  assert.equal(gainToDb(0), -12);
  assert.equal(formatGainDb(6), "+6 dB");
  assert.equal(formatGainDb(-3), "-3 dB");
  assert.equal(formatGainDb(0), "0 dB");
});

test("valor salvo inválido é rejeitado e o ganho absurdo é trazido para a faixa", () => {
  assert.equal(isMicTuning(DEFAULT_TUNING), true);
  assert.equal(isMicTuning({ gain: 0, agc: true, ns: true, echo: true }), false);
  assert.equal(isMicTuning({ gain: 1, agc: "sim", ns: true, echo: true }), false);
  assert.equal(isMicTuning(null), false);
  assert.ok(Math.abs(normalizeTuning({ ...DEFAULT_TUNING, gain: 50 }).gain - dbToGain(12)) < 1e-9);
});

test("pico e RMS de amostras float", () => {
  assert.equal(peakOf([0, 0.2, -0.6, 0.4]), 0.6);
  assert.equal(peakOf([]), 0);
  assert.equal(peakOf([2, -3]), 1);
  assert.equal(rmsOfFloat([]), 0);
  assert.equal(rmsOfFloat([0, 0, 0]), 0);
  assert.ok(Math.abs(rmsOfFloat([0.1, -0.1, 0.1, -0.1]) - 0.4) < 1e-9);
});

test("dB do nível", () => {
  assert.equal(formatLevelDb(1), "0 dB");
  assert.equal(formatLevelDb(0.5), "-6 dB");
  assert.equal(formatLevelDb(0), "−∞ dB");
});

test("orientação pelo pico retido", () => {
  assert.equal(levelHint(0).tone, "idle");
  assert.equal(levelHint(0.1).tone, "warn");
  assert.equal(levelHint(0.5).tone, "ok");
  assert.equal(levelHint(0.95).tone, "warn");
  assert.equal(levelHint(CLIP_LEVEL).tone, "err");
});

test("pico retido: sobe na hora, segura e depois cai", () => {
  const h = new PeakHold(1000, 0.5);
  assert.equal(h.feed(0.8, 0), 0.8);
  assert.equal(h.feed(0.1, 500), 0.8); // ainda segurando
  assert.ok(Math.abs(h.feed(0.1, 1100) - 0.75) < 1e-9); // retenção acabou em 1000: 100 ms de queda a 0.5/s
  const later = h.feed(0.1, 2100); // mais 1 s de queda
  assert.ok(Math.abs(later - 0.25) < 1e-9, `caiu para ${later}`);
  assert.equal(h.feed(0.9, 2200), 0.9); // novo pico sobe de uma vez
  h.reset();
  assert.equal(h.feed(0, 5000), 0);
});

test("restrições do navegador seguem as chaves; sem chaves, tudo ligado como antes", () => {
  assert.deepEqual(audioConstraints(""), { echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  assert.deepEqual(audioConstraints("abc", { agc: false, ns: true, echo: false }), {
    echoCancellation: false,
    noiseSuppression: true,
    autoGainControl: false,
    deviceId: { exact: "abc" },
  });
});

import { CaptureWatch } from "../src/lib/micTuning.ts";

test("CaptureWatch: zero exato por 2 s é captação morta (uma vez); qualquer sinal desarma", () => {
  const w = new CaptureWatch();
  assert.equal(w.feed(0, 500), false, "cedo demais");
  assert.equal(w.feed(0, 2100), true);
  assert.equal(w.feed(0, 2500), false, "só avisa uma vez");
  const ok = new CaptureWatch();
  assert.equal(ok.feed(0.0004, 300), false);
  assert.equal(ok.feed(0, 5000), false, "já viu sinal: silêncio depois não é falha");
});
