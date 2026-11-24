// Payload do menu nativo. O índice do clique tem de ser o mesmo de
// querySelectorAll("button"): uma linha divisória entra na lista desenhada,
// mas não desloca o número do botão que vem depois.

/**
 * A página só esconde o menu quando o host nativo está presente para
 * desenhar e receber o clique. Sem bethMenu, o menu da página continua
 * visível — senão o macOS fica com um menu em branco.
 */
export function pageMenuHidden(mac: boolean, hasBethMenu: boolean): boolean {
  return mac && hasBethMenu;
}

export function pageMenuStyle(mac: boolean, hasBethMenu: boolean): { visibility?: "hidden"; background?: "transparent"; boxShadow?: "none" } {
  if (!pageMenuHidden(mac, hasBethMenu)) return {};
  return { visibility: "hidden", background: "transparent", boxShadow: "none" };
}

export interface MenuRowPayload {
  /** índice em querySelectorAll("button"); ausente numa linha divisória */
  n?: number;
  t: string;
  i?: string;
  d?: number;
  hot?: number;
  y: number;
  h: number;
}

export interface MenuRowSource {
  rule: boolean;
  /** texto da primeira linha, o mesmo que a placa nativa desenha */
  label: string;
  symbol: string;
  danger: boolean;
  hot: boolean;
  y: number;
  h: number;
}

/**
 * Monta as linhas postadas. `n` no payload é o índice em
 * querySelectorAll("button"). O host clica pela posição na lista desenhada
 * (a mesma ordem de button + .bt-menu-rule): a divisória ocupa uma posição
 * e o item seguinte não herda o clique dela.
 */
export function menuRows(sources: MenuRowSource[]): { rows: MenuRowPayload[]; clickButton: (drawnIndex: number) => number | undefined } {
  let button = 0;
  const clickAt: Array<number | undefined> = [];
  const rows = sources.map((src) => {
    if (src.rule) {
      clickAt.push(undefined);
      return { t: "", y: src.y, h: src.h };
    }
    const n = button;
    clickAt.push(n);
    button += 1;
    return {
      n,
      t: src.label,
      i: src.symbol,
      d: src.danger ? 1 : 0,
      hot: src.hot ? 1 : 0,
      y: src.y,
      h: src.h,
    };
  });
  return {
    rows,
    clickButton: (drawnIndex) => clickAt[drawnIndex],
  };
}

/** Primeira linha do rótulo, lida do mesmo span que a placa desenha. */
export function menuRowLabel(labelText: string, fallbackText: string): string {
  const raw = labelText.trim() ? labelText : fallbackText;
  return raw.trim().split("\n")[0] ?? "";
}

/** O mínimo que o menu lê de cada nó: classe, texto e data-symbol. */
export interface MenuNode {
  className: string;
  textContent: string;
  /** texto do span.min-w-0, quando o botão tem rótulo separado do ícone */
  labelText?: string;
  symbol?: string;
  y?: number;
  h?: number;
}

/** O mesmo seletor que GlassMenu usa para postar bethMenu e receber o clique. */
export const MENU_ROW_SELECTOR = "button, .bt-menu-rule";

export interface MenuRowRoot {
  querySelectorAll: (sel: string) => ArrayLike<{
    className: string;
    textContent: string | null;
    matches: (sel: string) => boolean;
    getAttribute: (name: string) => string | null;
    querySelector: (sel: string) => { getAttribute: (name: string) => string | null; innerText?: string; textContent: string | null } | null;
  }>;
}

/**
 * O que __bethMenuClick faz: o host passa a posição na lista desenhada
 * (button + .bt-menu-rule). A divisória não tem botão. O número devolvido
 * é o índice em querySelectorAll("button").
 */
export function clickDrawnMenuRow(root: MenuRowRoot, drawnIndex: number): number | undefined {
  const nodes = Array.from(root.querySelectorAll(MENU_ROW_SELECTOR)).map((el) => readMenuNode(el));
  return menuRowsFromNodes(nodes).clickButton(drawnIndex);
}

/**
 * O mesmo caminho de rótulo que GlassMenu: primeiro o span interno de
 * span.min-w-0, senão o próprio span.min-w-0, senão o texto do botão.
 */
export function readMenuNode(el: {
  className: string;
  textContent: string | null;
  matches: (sel: string) => boolean;
  getAttribute: (name: string) => string | null;
  querySelector: (sel: string) => { getAttribute: (name: string) => string | null; innerText?: string; textContent: string | null } | null;
}): MenuNode {
  // Dois querySelector: o combinado devolve o span da dica em alguns
  // motores, e o rótulo vira "Mover para aba…continua rodando".
  const labelEl = el.querySelector(":scope > span.min-w-0 > span") ?? el.querySelector(":scope > span.min-w-0");
  return {
    className: el.className + (el.matches(":hover") ? " bt-menu-hot" : ""),
    textContent: el.textContent ?? "",
    labelText: (labelEl?.innerText ?? labelEl?.textContent ?? "").split("\n")[0] ?? "",
    symbol: el.querySelector("[data-symbol]")?.getAttribute("data-symbol") || el.getAttribute("data-symbol") || "",
  };
}

const SYMBOL: Record<string, string> = {
  pencil: "pencil",
  type: "textformat",
  x: "xmark",
  "rotate-cw": "arrow.clockwise",
  power: "power",
  "rotate-ccw": "arrow.uturn.backward",
  copy: "doc.on.doc",
  scissors: "scissors",
  paste: "doc.on.clipboard",
  "text-select": "selection.pin.in.out",
  link: "link",
  save: "square.and.arrow.down",
  "layout-grid": "square.grid.2x2",
  "panel-right": "rectangle.split.2x1",
  "panel-bottom": "rectangle.split.1x2",
  "panel-top": "rectangle.split.1x2",
  "panel-left": "rectangle.split.2x1",
  plus: "plus",
  "app-window": "macwindow",
  "log-out": "rectangle.portrait.and.arrow.right",
  "folder-input": "folder",
  columns: "rectangle.split.2x1",
  rows: "rectangle.split.1x2",
  "chevron-right": "chevron.right",
  "arrow-left": "chevron.left",
};

/** SF Symbol que a placa nativa desenha. */
export function menuSymbol(name: string | undefined): string | undefined {
  if (!name) return undefined;
  return SYMBOL[name] ?? name;
}

export interface MenuButtonSpec {
  label: string;
  symbol?: string;
  danger?: boolean;
  hint?: string;
  disabled?: boolean;
}

/** O botão que o menu renderiza. O teste lê este HTML; a página usa os mesmos campos. */
export function menuButtonHtml(spec: MenuButtonSpec): string {
  const symbol = menuSymbol(spec.symbol) ?? "";
  const danger = spec.danger ? " text-status-err" : "";
  const hint = spec.hint ? `<span class="block truncate text-[11px] text-text-3">${spec.hint}</span>` : "";
  return `<button type="button" data-symbol="${symbol}" class="flex w-full items-center gap-2 px-3 py-1.5 text-left${danger}"${spec.disabled ? " disabled" : ""}><span class="w-4 shrink-0" data-symbol="${symbol}"></span><span class="min-w-0 flex-1"><span class="block truncate">${spec.label}</span>${hint}</span></button>`;
}

export function menuRuleHtml(): string {
  return `<div class="bt-menu-rule my-1 border-t border-border"></div>`;
}

/** Lê a marcação do menu do mesmo jeito que GlassMenu posta bethMenu. */
export function menuRowsFromNodes(nodes: MenuNode[]): { rows: MenuRowPayload[]; clickButton: (n: number) => number | undefined } {
  return menuRows(
    nodes.map((el) => ({
      rule: el.className.split(/\s+/).includes("bt-menu-rule"),
      label: menuRowLabel(el.labelText ?? "", el.textContent),
      symbol: el.symbol ?? "",
      danger: el.className.split(/\s+/).includes("text-status-err"),
      hot: el.className.split(/\s+/).includes("bt-menu-hot"),
      y: el.y ?? 0,
      h: el.h ?? 0,
    })),
  );
}
