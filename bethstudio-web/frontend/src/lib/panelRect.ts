// Geometria do painel flutuante de arquivo/notas (FilePreviewPanel): mover,
// redimensionar por qualquer borda e encostar numa lateral. Funções puras;
// testadas em tests/panelRect.test.ts.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const PANEL_MIN_W = 360;
export const PANEL_MIN_H = 220;
export const PANEL_MARGIN = 16;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Mantém o painel inteiro dentro da janela, respeitando o tamanho mínimo. */
export function clampRect(r: Rect, vw: number, vh: number): Rect {
  const w = clamp(r.w, PANEL_MIN_W, Math.max(PANEL_MIN_W, vw));
  const h = clamp(r.h, PANEL_MIN_H, Math.max(PANEL_MIN_H, vh));
  return { w, h, x: clamp(r.x, 0, Math.max(0, vw - w)), y: clamp(r.y, 0, Math.max(0, vh - h)) };
}

/** Posição inicial: canto superior direito. */
export function defaultRect(w: number, h: number, vw: number, vh: number): Rect {
  return clampRect({ x: vw - w - PANEL_MARGIN, y: PANEL_MARGIN, w, h }, vw, vh);
}

export function moveRect(r: Rect, dx: number, dy: number, vw: number, vh: number): Rect {
  return clampRect({ ...r, x: r.x + dx, y: r.y + dy }, vw, vh);
}

/** Arrastar uma borda ou canto (dx/dy = quanto o ponteiro andou desde o início). */
export function resizeRect(start: Rect, edge: Edge, dx: number, dy: number, vw: number, vh: number): Rect {
  let { x, y, w, h } = start;
  if (edge.includes("e")) w = clamp(start.w + dx, PANEL_MIN_W, Math.max(PANEL_MIN_W, vw - start.x));
  if (edge.includes("w")) {
    const right = start.x + start.w;
    w = clamp(start.w - dx, PANEL_MIN_W, Math.max(PANEL_MIN_W, right));
    x = right - w;
  }
  if (edge.includes("s")) h = clamp(start.h + dy, PANEL_MIN_H, Math.max(PANEL_MIN_H, vh - start.y));
  if (edge.includes("n")) {
    const bottom = start.y + start.h;
    h = clamp(start.h - dy, PANEL_MIN_H, Math.max(PANEL_MIN_H, bottom));
    y = bottom - h;
  }
  return { x, y, w, h };
}

/** Encosta numa lateral, na altura toda da janela, mantendo a largura. */
export function dockRect(side: "left" | "right", r: Rect, vw: number, vh: number): Rect {
  const h = vh - 2 * PANEL_MARGIN;
  const w = clamp(r.w, PANEL_MIN_W, Math.max(PANEL_MIN_W, vw - 2 * PANEL_MARGIN));
  return clampRect({ x: side === "left" ? PANEL_MARGIN : vw - w - PANEL_MARGIN, y: PANEL_MARGIN, w, h }, vw, vh);
}

export function isRect(v: unknown): v is Rect {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return ["x", "y", "w", "h"].every((k) => typeof r[k] === "number" && Number.isFinite(r[k] as number));
}
