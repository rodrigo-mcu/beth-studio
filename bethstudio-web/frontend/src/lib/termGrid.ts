// Cartoes do popup "Todos os terminais" (grade com busca): um por terminal,
// vivo (em aba, em aba fechada ou solto) ou encerrado. Funcoes puras.
import type { PaneInfo } from "./types.ts";
import { closedGroupOf, findPane, leaves, tabDisplayName, type Layout } from "./layout.ts";
import { AGENT_FILTER, KIND_LABEL, kindGroup, kindOrder, type KindGroup } from "./kinds.ts";
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

/** "all" = todos os tipos. "agent" é o chip de agentes (o mesmo da barra lateral). */
export type GridKind = "all" | KindGroup | typeof AGENT_FILTER;

/** Todos os terminais conhecidos: os vivos do host primeiro (ordem de aba), depois os encerrados. */
export function buildCards(panes: PaneInfo[], layout: Layout): GridCard[] {
  const titleOf = (p: number) => {
    const i = panes.find((x) => x.pane_id === p);
    return i ? paneLabel(i) : undefined;
  };
  const cards: GridCard[] = [];
  const seen = new Set<number>();
  // Terminal sozinho numa aba (ou aba fechada): o cartao leva o nome da aba,
  // o mesmo que a barra de abas mostra. Em abas divididas vale o titulo do terminal.
  const push = (p: PaneInfo, state: CardState, where: string, tabId?: string, tabName?: string) => {
    seen.add(p.pane_id);
    cards.push({
      pane: p.pane_id,
      state,
      title: tabName || paneLabel(p),
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
      if (!leaf.gone && p && !seen.has(p.pane_id) && findPane(layout, p.pane_id)?.tabId === t.id) push(p, "tab", `Aba “${name}”`, t.id, leaves(t.root).filter((l) => !l.leaf.gone).length === 1 ? name : undefined);
    }
  });
  // 2) vivos fora das abas: em aba fechada ou soltos
  for (const p of panes) {
    if (seen.has(p.pane_id)) continue;
    const g = closedGroupOf(layout, p.pane_id);
    if (g >= 0) {
      const c = layout.closed![g];
      const cname = tabDisplayName(c, g, titleOf);
      push(p, "closed", `Aba fechada “${cname}”`, undefined, leaves(c.root).filter((l) => !l.leaf.gone).length === 1 ? cname : undefined);
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
  return [c.title, c.info ? paneLabel(c.info) : "", lastFolder(c.path), c.path, c.kindLabel, c.where, c.info?.ssh_host ?? "", `#${c.pane} pane ${c.pane}`, screen ?? ""]
    .join("\n")
    .toLowerCase();
}

/** Texto da busca casa com todos os termos. `screens` so' entra quando `withScreen`. */
export function matchesQuery(c: GridCard, query: string, screens?: Map<number, string>, withScreen = false): boolean {
  const ts = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!ts.length) return true;
  const h = haystack(c, withScreen ? screens?.get(c.pane) : undefined);
  return ts.every((t) => h.includes(t));
}

/**
 * Tipo do cartao. Encerrado nao tem `info`: nao inventa grupo (so' passa em "all").
 * O grupo e' o mesmo da barra lateral (`kindGroup`), inclusive bash/zsh em Outros.
 */
export function cardPassesKind(c: GridCard, kind: GridKind): boolean {
  if (kind === "all") return true;
  if (!c.info) return false;
  if (kind === AGENT_FILTER) return !!c.info.agent;
  return kindGroup(c.info) === kind;
}

/** Clicar no chip ativo (que nao e' Todos) volta para Todos. */
export function toggleChip<T extends string>(current: T, id: T, all: T): T {
  if (id === all) return all;
  return current === id ? all : id;
}

/**
 * Contagens da fileira de ESTADO. Ignoram o filtro de estado e respeitam tipo e busca,
 * para o numero de "Em abas" mudar ao escolher WSL sem zerar "Sem aba" ao clicar nele.
 */
export function facetStateCounts(cards: GridCard[], kind: GridKind, query: string, screens?: Map<number, string>, withScreen = false): Record<GridFilter, number> {
  return countByFilter(cards.filter((c) => cardPassesKind(c, kind) && matchesQuery(c, query, screens, withScreen)));
}

export interface GridKindChip {
  id: GridKind;
  label: string;
  count: number;
}

/**
 * Chips da fileira de TIPO, na ordem `kindOrder` (a da barra lateral). Ignoram o filtro
 * de tipo e respeitam estado e busca. So' entra tipo com contagem, mais o tipo ja'
 * escolhido (para dar para desmarcar). Encerrado sem `info` conta em Todos e em
 * nenhum tipo. O rotulo e' KIND_LABEL; kind_label vazio nao vira chip.
 */
export function facetKindChips(
  cards: GridCard[],
  state: GridFilter,
  query: string,
  screens?: Map<number, string>,
  withScreen = false,
  order?: string[] | null,
  selected: GridKind = "all",
): GridKindChip[] {
  const pool = cards.filter((c) => inFilter(c, state) && matchesQuery(c, query, screens, withScreen));
  const counts: Record<KindGroup, number> = { wsl: 0, powershell: 0, cmd: 0, gitbash: 0, ssh: 0, serial: 0, other: 0, unknown: 0 };
  let agents = 0;
  for (const c of pool) {
    if (!c.info) continue;
    counts[kindGroup(c.info)]++;
    if (c.info.agent) agents++;
  }
  const chips: GridKindChip[] = [{ id: "all", label: "Todos", count: pool.length }];
  for (const g of kindOrder(order)) {
    if (counts[g] > 0 || selected === g) chips.push({ id: g, label: KIND_LABEL[g], count: counts[g] });
  }
  if (agents > 0 || selected === AGENT_FILTER) chips.push({ id: AGENT_FILTER, label: "Agentes", count: agents });
  return chips;
}

/** Filtro de estado + tipo + busca (todos os termos, em qualquer campo). `screens` so' entra na busca quando `withScreen`. */
export function filterCards(cards: GridCard[], filter: GridFilter, query: string, screens?: Map<number, string>, withScreen = false, kind: GridKind = "all"): GridCard[] {
  return cards.filter((c) => inFilter(c, filter) && cardPassesKind(c, kind) && matchesQuery(c, query, screens, withScreen));
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
