// Posição da janela "Falar" (SpeakDialog): ela flutua sem escurecer a tela e
// o usuário a arrasta pelo título para não cobrir o que está lendo. Funções
// puras; testadas em tests/speakPos.test.ts.

export interface Pos {
  x: number;
  y: number;
}

export const SPEAK_POS_KEY = "bt.speak.pos";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function isPos(v: unknown): v is Pos {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return ["x", "y"].every((k) => typeof r[k] === "number" && Number.isFinite(r[k] as number));
}

/** Mantém a janela (w x h) inteira dentro da área visível vw x vh. */
export function keepInside(p: Pos, w: number, h: number, vw: number, vh: number): Pos {
  return { x: clamp(p.x, 0, Math.max(0, vw - w)), y: clamp(p.y, 0, Math.max(0, vh - h)) };
}

/** Posição ao abrir: a última salva, ou centralizada no alto (como era o modal). */
export function initialPos(saved: Pos | null, w: number, h: number, vw: number, vh: number): Pos {
  return keepInside(saved ?? { x: (vw - w) / 2, y: vh * 0.08 }, w, h, vw, vh);
}
