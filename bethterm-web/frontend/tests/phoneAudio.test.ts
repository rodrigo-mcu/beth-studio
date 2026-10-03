import { test } from "node:test";
import assert from "node:assert/strict";
import { appendDictation, chooseTake, clock, Downsampler, encodeWav, WAV_RATE } from "../src/phone/audio.ts";

test("Downsampler: 48 kHz vira 16 kHz, mesmo em blocos quebrados", () => {
  const d = new Downsampler(48000);
  const one = new Float32Array(4096).fill(0.5);
  for (let i = 0; i < 12; i++) d.push(one); // ~1 s
  assert.equal(d.length, Math.floor((4096 * 12) / 3));
  const s = d.samples();
  assert.ok(Math.abs(s[10] - 0.5) < 1e-6);
});

test("Downsampler: 44,1 kHz dá ~16000 amostras por segundo", () => {
  const d = new Downsampler(44100);
  const blk = new Float32Array(1000);
  for (let i = 0; i < 44; i++) d.push(blk);
  d.push(new Float32Array(100));
  assert.ok(Math.abs(d.length - 16000) <= 1, String(d.length));
});

test("encodeWav: cabeçalho RIFF mono 16 bits", () => {
  const w = encodeWav(new Float32Array([0, 1, -1]));
  const v = new DataView(w.buffer);
  assert.equal(String.fromCharCode(...w.slice(0, 4)), "RIFF");
  assert.equal(v.getUint32(24, true), WAV_RATE);
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(40, true), 6);
  assert.equal(v.getInt16(46, true), 0x7fff);
  assert.equal(v.getInt16(48, true), -0x8000);
});

test("chooseTake: MP4 oco do iPhone (1392 bytes em 8 s) sobe o WAV", () => {
  assert.equal(chooseTake({ seconds: 8.3, recorderBytes: 1392, pcmSamples: 8.3 * WAV_RATE, peak: 0.4 }), "wav");
});

test("chooseTake: gravador saudável vai primeiro", () => {
  assert.equal(chooseTake({ seconds: 8, recorderBytes: 60000, pcmSamples: 8 * WAV_RATE, peak: 0.4 }), "recorder");
});

test("chooseTake: silêncio de verdade não sobe", () => {
  assert.equal(chooseTake({ seconds: 5, recorderBytes: 40000, pcmSamples: 5 * WAV_RATE, peak: 0.001 }), "silent");
});

test("chooseTake: sem PCM, confia no gravador; sem nada, vazio", () => {
  assert.equal(chooseTake({ seconds: 5, recorderBytes: 40000, pcmSamples: 0, peak: 0 }), "recorder");
  assert.equal(chooseTake({ seconds: 5, recorderBytes: 900, pcmSamples: 0, peak: 0 }), "empty");
});

test("clock e appendDictation", () => {
  assert.equal(clock(7400), "0:07");
  assert.equal(clock(92000), "1:32");
  assert.equal(appendDictation("", " oi "), "oi");
  assert.equal(appendDictation("primeira parte.  ", "segunda"), "primeira parte. segunda");
  assert.equal(appendDictation("fica", "  "), "fica");
});
