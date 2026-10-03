// A- / A+ no cabecalho do terminal.

export const MIN_FONT_PX = 5;
export const MAX_FONT_PX = 48;

/**
 * Proximo tamanho fixo. `fixed` = tamanho salvo do pane (0 = automatico);
 * `effective` = tamanho que o xterm usa agora (no automatico, o ajustado a'
 * area). Do automatico, parte do efetivo arredondado.
 */
export function nextFontSize(fixed: number, effective: number, delta: number): number {
  const base = fixed > 0 ? fixed : Math.round(effective || 14);
  return Math.max(MIN_FONT_PX, Math.min(MAX_FONT_PX, Math.round(base) + delta));
}

export function fontSizeLabel(fixed: number): string {
  return fixed > 0 ? `${fixed}px` : "auto";
}

/**
 * Fonte fixa efetiva (0 = automatica):
 *  - "Ajustar a' janela": a do pane, senao a padrao geral, senao 14;
 *  - "Igual ao BethTerm" (ou Ajustar indisponivel): AUTOMATICA, a nao ser
 *    que o usuario tenha fixado NESTE pane (A-/A+ nele). O padrao geral
 *    fixo nao vale aqui.
 */
export function fixedFontFor(mode: "fit" | "host", paneSize: number, defaultSize: number): number {
  if (mode === "fit") return paneSize || defaultSize || 14;
  return paneSize || 0;
}

/** Dica "clique para ajustar": fonte fixa e o grid ocupa < 70% da area. */
export function smallGridHint(fixed: number, gridW: number, gridH: number, areaW: number, areaH: number): boolean {
  if (!(fixed > 0) || !(areaW > 0) || !(areaH > 0)) return false;
  return (gridW * gridH) / (areaW * areaH) < 0.7;
}
