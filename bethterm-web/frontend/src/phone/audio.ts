// Áudio do celular: reamostragem para 16 kHz, WAV e a escolha entre o que o
// MediaRecorder entregou e o PCM gravado em paralelo. Funções puras testadas
// em tests/phoneAudio.test.ts.
//
// Por que dois caminhos: o Safari do iPhone às vezes entrega do MediaRecorder
// só o cabeçalho do MP4 (1392 bytes para 8 s de fala, visto no log em
// 2026-09-27). O PCM, lido direto do microfone pelo Web Audio, não depende
// desse gravador.

export const WAV_RATE = 16000;

/** Abaixo disto por segundo, o arquivo do MediaRecorder não tem som de verdade. */
export const MIN_BYTES_PER_SEC = 1500;

/** Pico (0..1) abaixo do qual a gravação inteira é tratada como silêncio. */
export const SILENT_PEAK = 0.01;

/** Reamostra em blocos, sem perder a fase entre um bloco e o próximo (média por janela). */
export class Downsampler {
  private ratio: number;
  private pos = 0;
  private acc = 0;
  private n = 0;
  private out: Float32Array[] = [];
  private total = 0;

  constructor(inRate: number, outRate = WAV_RATE) {
    this.ratio = inRate / outRate;
    if (!(this.ratio >= 1)) this.ratio = 1;
  }

  push(block: ArrayLike<number>) {
    const res: number[] = [];
    for (let i = 0; i < block.length; i++) {
      this.acc += block[i];
      this.n++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        res.push(this.acc / this.n);
        this.acc = 0;
        this.n = 0;
      }
    }
    if (res.length) {
      this.out.push(Float32Array.from(res));
      this.total += res.length;
    }
  }

  get length() {
    return this.total;
  }

  samples(): Float32Array {
    const all = new Float32Array(this.total);
    let o = 0;
    for (const b of this.out) {
      all.set(b, o);
      o += b.length;
    }
    return all;
  }
}

/** WAV PCM 16 bits, mono. */
export function encodeWav(samples: Float32Array, rate = WAV_RATE): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/** Pico absoluto de um bloco. */
export function peakOf(block: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < block.length; i++) {
    const a = Math.abs(block[i]);
    if (a > p) p = a;
  }
  return p;
}

/** Nível para o medidor (0..1), com curva que deixa a fala visível. */
export function meterLevel(peak: number): number {
  if (peak <= 0) return 0;
  return Math.min(1, Math.sqrt(peak) * 1.4);
}

export interface Take {
  /** segundos gravados */
  seconds: number;
  /** bytes do MediaRecorder (0 = sem MediaRecorder) */
  recorderBytes: number;
  /** amostras de PCM em 16 kHz (0 = Web Audio não entregou nada) */
  pcmSamples: number;
  /** maior pico visto no PCM */
  peak: number;
}

export type TakeChoice = "recorder" | "wav" | "silent" | "empty";

/**
 * Qual arquivo sobe. O do MediaRecorder é menor e vai primeiro; se ele veio
 * oco, sobe o WAV. Silêncio no PCM (com PCM de verdade) não sobe nada.
 */
export function chooseTake(t: Take): TakeChoice {
  const pcmOk = t.pcmSamples >= WAV_RATE * 0.25;
  if (pcmOk && t.peak < SILENT_PEAK) return "silent";
  const recorderOk = t.recorderBytes >= Math.max(2000, t.seconds * MIN_BYTES_PER_SEC);
  if (recorderOk) return "recorder";
  if (pcmOk) return "wav";
  return "empty";
}

/** 0:07, 1:32 */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Junta um ditado novo ao texto que já está no campo. */
export function appendDictation(current: string, next: string): string {
  const a = current.replace(/\s+$/u, "");
  const b = next.trim();
  if (!a) return b;
  if (!b) return a;
  return `${a} ${b}`;
}
