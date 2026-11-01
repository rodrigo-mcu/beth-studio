// Ajustes da captação do Falar: ganho (volume de entrada), chaves de
// processamento do navegador e as contas do medidor (pico, dB, saturação).
// Funções puras testadas em tests/micTuning.test.ts.

export interface MicTuning {
  /** multiplicador linear aplicado antes de gravar (1 = sem mudança) */
  gain: number;
  /** controle automático de ganho do navegador */
  agc: boolean;
  /** supressão de ruído do navegador */
  ns: boolean;
  /** cancelamento de eco do navegador */
  echo: boolean;
}

export const MIC_TUNING_KEY = "bethstudio.micTuning";
export const DEFAULT_TUNING: MicTuning = { gain: 1, agc: true, ns: true, echo: true };

/** Faixa do controle de volume, em dB. */
export const GAIN_DB_MIN = -12;
export const GAIN_DB_MAX = 12;

/** Pico a partir do qual o som satura (clipping). */
export const CLIP_LEVEL = 0.97;

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export const dbToGain = (db: number) => 10 ** (clamp(db, GAIN_DB_MIN, GAIN_DB_MAX) / 20);
export const gainToDb = (g: number) => (g > 0 ? clamp(Math.round(20 * Math.log10(g)), GAIN_DB_MIN, GAIN_DB_MAX) : GAIN_DB_MIN);

export function isMicTuning(v: unknown): v is MicTuning {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.gain === "number" &&
    Number.isFinite(t.gain) &&
    t.gain > 0 &&
    typeof t.agc === "boolean" &&
    typeof t.ns === "boolean" &&
    typeof t.echo === "boolean"
  );
}

/** Mantém o ganho dentro da faixa (valor salvo à mão ou corrompido). */
export const normalizeTuning = (t: MicTuning): MicTuning => ({ ...t, gain: dbToGain(gainToDb(t.gain)) });

export function formatGainDb(db: number): string {
  const sign = db > 0 ? "+" : "";
  return `${sign}${db} dB`;
}

/** Pico absoluto (0..1) de amostras float de getFloatTimeDomainData. */
export function peakOf(buf: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > p) p = a;
  }
  return Math.min(1, p);
}

/** Nível RMS (0..1) de amostras float, na mesma escala (x4) do `rmsLevel` antigo. */
export function rmsOfFloat(buf: ArrayLike<number>): number {
  if (!buf.length) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.min(1, Math.sqrt(sum / buf.length) * 4);
}

/** Nível linear (0..1) em dBFS; -Infinity quando é silêncio total. */
export const levelToDb = (level: number) => (level <= 0.00003 ? -Infinity : 20 * Math.log10(Math.min(1, level)));

export function formatLevelDb(level: number): string {
  const db = levelToDb(level);
  return Number.isFinite(db) ? `${Math.round(db)} dB` : "−∞ dB";
}

/** Texto curto de orientação a partir do pico retido. */
export function levelHint(hold: number): { tone: "ok" | "warn" | "err" | "idle"; text: string } {
  if (hold >= CLIP_LEVEL) return { tone: "err", text: "Estourando — abaixe o volume de entrada" };
  if (hold < 0.04) return { tone: "idle", text: "Sem sinal" };
  if (hold < 0.2) return { tone: "warn", text: "Fraco — fale mais perto ou aumente o volume" };
  if (hold > 0.9) return { tone: "warn", text: "Quase estourando" };
  return { tone: "ok", text: "Bom nível" };
}

/** Pico retido: sobe na hora, segura `holdMs` e depois cai devagar. */
export class PeakHold {
  private value = 0;
  private at = 0;
  private lastNow = 0;
  private holdMs: number;
  private fallPerSec: number;
  constructor(holdMs = 1200, fallPerSec = 0.8) {
    this.holdMs = holdMs;
    this.fallPerSec = fallPerSec;
  }
  feed(peak: number, now: number): number {
    const prev = this.lastNow;
    this.lastNow = now;
    if (peak >= this.value) {
      this.value = peak;
      this.at = now;
    } else if (prev && now > this.at + this.holdMs) {
      // só conta a queda a partir do fim da retenção
      const dt = (now - Math.max(prev, this.at + this.holdMs)) / 1000;
      this.value = Math.max(peak, this.value - this.fallPerSec * dt);
    }
    return this.value;
  }
  reset() {
    this.value = 0;
    this.at = 0;
    this.lastNow = 0;
  }
}

/**
 * Captação morta: o gravador está rodando mas nenhuma amostra diferente de
 * zero chegou. Ruído de fundo, mesmo baixo, nunca é zero exato; zero exato
 * por 2 s é o contexto de áudio parado ou o microfone que o Windows entregou
 * mudo. `feed` devolve true uma vez, quando dá para desistir e recomeçar.
 */
export class CaptureWatch {
  private seen = false;
  private fired = false;
  private readonly deadAfterMs: number;
  constructor(deadAfterMs = 2000) {
    this.deadAfterMs = deadAfterMs;
  }
  feed(peak: number, elapsedMs: number): boolean {
    if (peak > 0) this.seen = true;
    if (this.seen || this.fired || elapsedMs < this.deadAfterMs) return false;
    this.fired = true;
    return true;
  }
}
