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
  /** lado do elemento em que o balão ficou */
  side: "below" | "above" | "right" | "left";
}

export const TIP_GAP = 8;
export const TIP_MARGIN = 6;

/** Escolhe o lado com espaço. Prefere embaixo, depois acima, depois a
 *  direita, depois a esquerda. A seta aponta para o elemento. */
export function placeTip(anchor: Rect, tipW: number, tipH: number, viewW: number, viewH: number): TipPlace {
  const cx = anchor.left + anchor.width / 2;
  const cy = anchor.top + anchor.height / 2;
  const below = viewH - (anchor.top + anchor.height) - TIP_MARGIN;
  const above = anchor.top - TIP_MARGIN;
  const right = viewW - (anchor.left + anchor.width) - TIP_MARGIN;
  const leftRoom = anchor.left - TIP_MARGIN;
  const order: Array<"below" | "above" | "right" | "left"> = ["below", "above", "right", "left"];
  const room = { below, above, right, left: leftRoom };
  const need = { below: tipH + TIP_GAP, above: tipH + TIP_GAP, right: tipW + TIP_GAP, left: tipW + TIP_GAP };
  const side = order.find((s) => room[s] >= need[s]) ?? order.reduce((a, b) => (room[b] > room[a] ? b : a));
  if (side === "right" || side === "left") {
    let top = cy - tipH / 2;
    top = Math.max(TIP_MARGIN, Math.min(top, viewH - tipH - TIP_MARGIN));
    const left = side === "right" ? anchor.left + anchor.width + TIP_GAP : anchor.left - TIP_GAP - tipW;
    const arrowX = side === "right" ? 0 : tipW;
    return { left: Math.max(TIP_MARGIN, Math.min(left, viewW - tipW - TIP_MARGIN)), top, arrowX, above: false, side };
  }
  let left = cx - tipW / 2;
  left = Math.max(TIP_MARGIN, Math.min(left, viewW - tipW - TIP_MARGIN));
  const top = side === "above" ? anchor.top - TIP_GAP - tipH : anchor.top + anchor.height + TIP_GAP;
  const arrowX = Math.max(10, Math.min(cx - left, tipW - 10));
  return { left, top, arrowX, above: side === "above", side };
}

export const TIP_DELAY_MS = 350;
