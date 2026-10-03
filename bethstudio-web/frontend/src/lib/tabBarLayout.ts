// Barra de abas que nunca estoura: os botoes de acao sao sempre so' icone
// (32x32, tooltip com nome e funcao); se nem os icones couberem, os de menor
// prioridade vao para o menu "…". Funcao pura (tests/tabBarLayout.test.ts).

export interface BarAction {
  id: string;
  label: string;
  /** maior = some por ultimo */
  priority: number;
}

export interface BarPlan {
  /** acoes na barra, na ordem original, e se mostram o texto */
  shown: { id: string; label: boolean }[];
  /** acoes no menu "…" (ordem original) */
  overflow: string[];
}

/** botao 32 px + 2 px de espaco */
export const ICON_W = 34;
export const MORE_W = 34;

/** Largura aproximada de um botao com texto (icone 14 + folgas + ~7 px por letra). */
export function labelWidth(label: string): number {
  return 36 + Math.ceil(label.length * 7);
}

/**
 * `available` = o que sobra para as acoes depois do minimo das abas, da area
 * de arraste, dos botoes da janela etc.
 */
export function planBarActions(available: number, actions: BarAction[]): BarPlan {
  const withLabel = new Set<string>(); // sempre so' icone
  const inBar = new Set(actions.map((a) => a.id));
  const width = () => {
    let w = 0;
    for (const a of actions) if (inBar.has(a.id)) w += withLabel.has(a.id) ? labelWidth(a.label) : ICON_W;
    if (inBar.size < actions.length) w += MORE_W;
    return w;
  };
  const byPriority = [...actions].sort((a, b) => a.priority - b.priority);
  // nao cabe: menor prioridade vai para o "…"
  for (const a of byPriority) {
    if (width() <= available) break;
    inBar.delete(a.id);
  }
  return {
    shown: actions.filter((a) => inBar.has(a.id)).map((a) => ({ id: a.id, label: withLabel.has(a.id) })),
    overflow: actions.filter((a) => !inBar.has(a.id)).map((a) => a.id),
  };
}
