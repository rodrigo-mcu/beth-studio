import { test } from "node:test";
import assert from "node:assert/strict";
import { agoLabel, countdownLabel, deviceTitle, pairingState, type Pairing } from "../src/lib/phoneDevices.ts";

const T0 = Date.parse("2026-10-18T12:00:00Z");

test("agoLabel: agora, minutos, horas, dias", () => {
  const at = (s: number) => new Date(T0 - s * 1000).toISOString();
  assert.equal(agoLabel(at(5), T0), "agora");
  assert.equal(agoLabel(at(5 * 60), T0), "há 5 min");
  assert.equal(agoLabel(at(3 * 3600), T0), "há 3 h");
  assert.equal(agoLabel(at(86400), T0), "há 1 dia");
  assert.equal(agoLabel(at(10 * 86400), T0), "há 10 dias");
  assert.equal(agoLabel("lixo", T0), "—");
  assert.equal(agoLabel(new Date(T0 + 5000).toISOString(), T0), "agora"); // relógio adiantado
});

test("countdownLabel: m:ss e null ao vencer", () => {
  const exp = new Date(T0 + 4 * 60000 + 32000).toISOString();
  assert.equal(countdownLabel(exp, T0), "4:32");
  assert.equal(countdownLabel(exp, T0 + 4 * 60000 + 27000), "0:05");
  assert.equal(countdownLabel(exp, T0 + 5 * 60000), null);
  assert.equal(countdownLabel("x", T0), null);
});

test("pairingState: idle, waiting, used, expired", () => {
  const p: Pairing = { link: "https://x/#pair=a", qr: "data:", expires_at: new Date(T0 + 300000).toISOString() };
  assert.equal(pairingState(null, 0, T0), "idle");
  assert.equal(pairingState(p, 1, T0 + 1000), "waiting");
  assert.equal(pairingState(p, 0, T0 + 60000), "used"); // alguém usou o link
  assert.equal(pairingState(p, 1, T0 + 301000), "expired");
  assert.equal(pairingState(p, 0, T0 + 301000), "expired");
});

test("deviceTitle: nunca vazio", () => {
  assert.equal(deviceTitle({ name: "  iPhone — Safari " }), "iPhone — Safari");
  assert.equal(deviceTitle({ name: "   " }), "Celular");
});
