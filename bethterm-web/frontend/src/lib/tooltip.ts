// Tooltip proprio (o `title` nativo nao aparece de forma confiavel na janela
// sem moldura). Funcoes puras testadas em tests/tooltip.test.ts; a camada
// que mostra fica em components/TooltipLayer.tsx.

export interface TipText {
  title: string;
  desc: string;
}

/**
 * "Nome: descricao" / "Nome — descricao" / "Nome (descricao)" / "Nome\ndescricao"
 * -> nome em negrito + descricao na linha de baixo.
 */
export function parseTip(raw: string): TipText {
  const text = raw.trim();
  const nl = text.indexOf("\n");
  if (nl > 0) return { title: text.slice(0, nl).trim(), desc: text.slice(nl + 1).trim() };
  const m = /^(.{1,40}?)(?::\s+| — | - )(.+)$/s.exec(text);
  if (m) return { title: m[1].trim(), desc: m[2].trim() };
  const p = /^([^()]{1,40}?)\s*\((.+)\)$/s.exec(text);
  if (p) return { title: p[1].trim(), desc: p[2].trim() };
  return { title: text, desc: "" };
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TipPlace {
  left: number;
  top: number;
  /** posicao da seta, relativa ao tooltip */
  arrowX: number;
  /** true = acima do elemento (nao coube embaixo) */
  above: boolean;
}

export const TIP_GAP = 8;
export const TIP_MARGIN = 6;

/** Abaixo do elemento, centralizado; empurrado para dentro da janela nas bordas. */
export function placeTip(anchor: Rect, tipW: number, tipH: number, viewW: number, viewH: number): TipPlace {
  const cx = anchor.left + anchor.width / 2;
  let left = cx - tipW / 2;
  left = Math.max(TIP_MARGIN, Math.min(left, viewW - tipW - TIP_MARGIN));
  let top = anchor.top + anchor.height + TIP_GAP;
  let above = false;
  if (top + tipH > viewH - TIP_MARGIN && anchor.top - TIP_GAP - tipH >= TIP_MARGIN) {
    top = anchor.top - TIP_GAP - tipH;
    above = true;
  }
  const arrowX = Math.max(10, Math.min(cx - left, tipW - 10));
  return { left, top, arrowX, above };
}

export const TIP_DELAY_MS = 350;
