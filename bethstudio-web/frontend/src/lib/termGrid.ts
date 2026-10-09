// Cartoes do popup "Todos os terminais" (grade com busca): um por terminal,
// vivo (em aba, em aba fechada ou solto) ou encerrado. Funcoes puras.
import type { PaneInfo } from "./types.ts";
import { closedGroupOf, findPane, leaves, tabDisplayName, type Layout } from "./layout.ts";
import { paneLabel, shortCwd } from "./panes.ts";
import { lastFolder, stripAnsi } from "./search.ts";

/** em aba · numa aba fechada · fora de qualquer aba · encerrado (marcador na aba) */
export type CardState = "tab" | "closed" | "loose" | "gone";

export interface GridCard {
  pane: number;
  state: CardState;
  title: string;
  /** caminho legivel da pasta atual ("" = desconhecido) */
  path: string;
  kindLabel: string;
  /** "Aba “x”", "Aba fechada “x”", "Não organizado" ou "Encerrado · aba “x”" */
  where: string;
  /** aba que contem o terminal (so' state "tab" e "gone") */
  tabId?: string;
  info?: PaneInfo;
}

export type GridFilter = "all" | "tab" | "hidden" | "gone";

/** Todos os terminais conhecidos: os vivos do host primeiro (ordem de aba), depois os encerrados. */
export function buildCards(panes: PaneInfo[], layout: Layout): GridCard[] {
  const titleOf = (p: number) => {
    const i = panes.find((x) => x.pane_id === p);
    return i ? paneLabel(i) : undefined;
  };
  const cards: GridCard[] = [];
  const seen = new Set<number>();
  const push = (p: PaneInfo, state: CardState, where: string, tabId?: string) => {
    seen.add(p.pane_id);
    cards.push({
      pane: p.pane_id,
      state,
      title: paneLabel(p),
      path: shortCwd(p.cwd, 99),
      kindLabel: p.kind_label || "",
      where,
      tabId,
      info: p,
    });
  };
  const byId = new Map(panes.map((p) => [p.pane_id, p]));
  // 1) vivos nas abas, na ordem da barra
  layout.tabs.forEach((t, i) => {
    const name = tabDisplayName(t, i, titleOf);
    for (const { leaf } of leaves(t.root)) {
      const p = byId.get(leaf.pane);
      if (!leaf.gone && p && !seen.has(p.pane_id) && findPane(layout, p.pane_id)?.tabId === t.id) push(p, "tab", `Aba “${name}”`, t.id);
    }
  });
  // 2) vivos fora das abas: em aba fechada ou soltos
  for (const p of panes) {
    if (seen.has(p.pane_id)) continue;
    const g = closedGroupOf(layout, p.pane_id);
    if (g >= 0) {
      const c = layout.closed![g];
      push(p, "closed", `Aba fechada “${tabDisplayName(c, g, titleOf)}”`);
    } else push(p, "loose", "Não organizado");
  }
  // 3) encerrados que ainda aparecem numa aba
  layout.tabs.forEach((t, i) => {
    const name = tabDisplayName(t, i, titleOf);
    for (const { leaf } of leaves(t.root)) {
      if (!leaf.gone) continue;
      cards.push({
        pane: leaf.pane,
        state: "gone",
        title: leaf.title || `Terminal ${leaf.pane}`,
        path: shortCwd(leaf.cwd ?? "", 99),
        kindLabel: "",
        where: `Encerrado · aba “${name}”`,
        tabId: t.id,
      });
    }
  });
  return cards;
}

export function countByFilter(cards: GridCard[]): Record<GridFilter, number> {
  return {
    all: cards.length,
    tab: cards.filter((c) => c.state === "tab").length,
    hidden: cards.filter((c) => c.state === "closed" || c.state === "loose").length,
    gone: cards.filter((c) => c.state === "gone").length,
  };
}

function inFilter(c: GridCard, f: GridFilter): boolean {
  if (f === "all") return true;
  if (f === "tab") return c.state === "tab";
  if (f === "hidden") return c.state === "closed" || c.state === "loose";
  return c.state === "gone";
}

/** Texto onde a busca procura (minusculo): titulo, pasta, caminho, tipo, aba, id e, se houver, a tela. */
function haystack(c: GridCard, screen?: string): string {
  return [c.title, lastFolder(c.path), c.path, c.kindLabel, c.where, c.info?.ssh_host ?? "", `#${c.pane} pane ${c.pane}`, screen ?? ""]
    .join("\n")
    .toLowerCase();
}

/** Filtro + busca (todos os termos, em qualquer campo). `screens` so' entra na busca quando `withScreen`. */
export function filterCards(cards: GridCard[], filter: GridFilter, query: string, screens?: Map<number, string>, withScreen = false): GridCard[] {
  const ts = query.toLowerCase().split(/\s+/).filter(Boolean);
  return cards.filter((c) => {
    if (!inFilter(c, filter)) return false;
    if (!ts.length) return true;
    const h = haystack(c, withScreen ? screens?.get(c.pane) : undefined);
    return ts.every((t) => h.includes(t));
  });
}

/** Ultimas linhas com texto da tela (o "print" do cartao). */
export function previewLines(raw: string | undefined, max = 7, width = 90): string[] {
  if (!raw) return [];
  const rows = stripAnsi(raw)
    .split("\n")
    .map((r) => r.replace(/\s+$/, ""))
    .filter((r) => r.trim() !== "");
  return rows.slice(-max).map((r) => (r.length > width ? r.slice(0, width) : r));
}
