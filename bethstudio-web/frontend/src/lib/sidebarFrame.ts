// Faixa das sidebars. Função pura: o material nativo e o CSS têm de
// concordar com estes números, senão o vibrancy pinta a coluna inteira.

export const SIDE_INSET = 8;
export const TAB_STRIP = 40;
export const CARD_BOTTOM_PAD = 8;

export interface SideFrame {
  /** topo do cartão, abaixo da faixa das abas */
  top: number;
  /** base do cartão, SIDE_INSET acima do fundo da janela */
  bottom: number;
  height: number;
  /** cor do vão em volta: a mesma da topbar */
  gutter: string;
}

export function sideFrame(windowHeight: number, topbarColor: string, tabStrip = TAB_STRIP, inset = SIDE_INSET, banner = 0, bottomPad = CARD_BOTTOM_PAD): SideFrame {
  const top = tabStrip + inset;
  const bottom = Math.max(0, windowHeight - bottomPad);
  return {
    top,
    bottom,
    height: Math.max(0, bottom - top - banner),
    gutter: topbarColor,
  };
}

/** O botão da pasta alterna a guia e diz se o painel da direita monta. */
export function toggleFolderPanel(openByTab: Record<string, boolean>, tabId: string, savedOpen: boolean): { open: boolean; next: Record<string, boolean>; mount: boolean } {
  const open = !(openByTab[tabId] ?? savedOpen);
  return { open, next: { ...openByTab, [tabId]: open }, mount: open && tabId.length > 0 };
}

export interface GlassRect {
  x: number;
  y: number;
  w: number;
  h: number;
  windowH: number;
}

/** Lê a linha que a janela grava do retângulo real do vidro. */
export function parseGlassLine(line: string): GlassRect | null {
  const m = /glass x (-?\d+) y (-?\d+) w (-?\d+) h (-?\d+) windowH (-?\d+)/.exec(line);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]), windowH: Number(m[5]) };
}

/**
 * O material BehindWindow aparece por cima da página. O vão (borda, faixa
 * dos semáforos, vão até o terminal) tem de continuar a cor da topbar.
 * O cartão, inset px para dentro, é onde o efeito pode aparecer.
 */
export function glassCoversGutter(rect: GlassRect, sidebarWidth: number, inset = SIDE_INSET): boolean {
  if (rect.w <= 0 || rect.h <= 0) return false;
  if (rect.x < inset - 0.5) return true;
  if (rect.y < 0) return true;
  if (rect.y + rect.h > rect.windowH - inset + 0.5) return true;
  if (rect.x + rect.w > sidebarWidth - inset + 0.5) return true;
  return sidebarWidth < 0 || inset < 0;
}

/**
 * Com o vibrancy ligado o vidro ocupa o cartão: 8 px da borda, abaixo das
 * abas, 8 px antes do terminal e 8 px acima do fundo. Largura 0 não mostra
 * efeito nenhum. Desligado, o retângulo fica fora da janela.
 */
export function vibrancyCardRect(
  on: boolean,
  windowHeight: number,
  sidebarWidth: number,
  inset = SIDE_INSET,
  tabStrip = TAB_STRIP,
  bottomPad = CARD_BOTTOM_PAD,
): GlassRect {
  if (!on || sidebarWidth <= inset * 2) {
    return { x: -8, y: -8, w: 0, h: 0, windowH: windowHeight };
  }
  const top = tabStrip + inset;
  const bottom = Math.max(top, windowHeight - bottomPad);
  return {
    x: inset,
    y: bottomPad,
    w: Math.max(0, sidebarWidth - inset * 2),
    h: Math.max(0, bottom - top),
    windowH: windowHeight,
  };
}

/** As duas barras usam a mesma faixa. */
export function framesMatch(a: SideFrame, b: SideFrame): boolean {
  return a.top === b.top && a.bottom === b.bottom && a.height === b.height && a.gutter === b.gutter;
}

export interface RightSlot {
  /** vão até a borda direita da janela */
  edge: number;
  /** vão até o terminal */
  terminal: number;
  /** base do cartão, acima do fundo da janela */
  bottom: number;
}

/** Com a pasta aberta, a direita usa o mesmo vão da esquerda. */
export function rightSlot(open: boolean, inset = SIDE_INSET, bottomPad = CARD_BOTTOM_PAD): RightSlot | null {
  if (!open) return null;
  return { edge: inset, terminal: inset, bottom: bottomPad };
}

/**
 * Controles cujo texto a página esconde de propósito, e o vidro nativo
 * redesenha: busca, botões de modo, botões de ícone, abas inativas.
 * A linha de terminal e o chip de filtro viram placa do mesmo jeito que o
 * botão de modo: o vidro desenha ícone e nome. O cabeçalho de pasta fica
 * sem fundo e sem placa.
 */
export function wantsNativeGlassPlate(className: string): boolean {
  const classes = className.split(/\s+/).filter(Boolean);
  const has = (name: string) => classes.includes(name);
  if (has("bt-folder") || has("bt-chip")) return false;
  if (has("bt-chat") || has("bt-search") || has("bt-mode") || has("bt-tab") || has("bt-tab-tool") || has("bt-glass-sample")) return true;
  // Botão só de ícone (h-7). A lista e os chips também levam bt-glass.
  return has("bt-glass") && has("h-7");
}

export interface GlassPlateFields {
  className: string;
  /** texto que a placa nativa redesenharia; vazio numa linha de chat */
  label: string;
  selected: boolean;
  /** 1 = material da linha, sem rótulo dentro da placa */
  row: 0 | 1;
}

/** O que a página posta para uma linha. Chat entra sem rótulo duplicado. */
export function glassPlateFields(className: string, label: string): GlassPlateFields | null {
  if (!wantsNativeGlassPlate(className)) return null;
  const classes = className.split(/\s+/).filter(Boolean);
  const chat = classes.includes("bt-chat");
  return {
    className,
    label,
    selected: classes.includes("bt-glass-on"),
    row: chat ? 1 : 0,
  };
}

export interface GlassPlateCandidate {
  className: string;
}

/**
 * O que App.tsx posta em bethGlass. Desligado, a lista é vazia: nenhuma
 * placa nativa. Ligado, só os controles cujo texto a página esconde.
 */
export function nativeGlassPlates<T extends GlassPlateCandidate>(vibrancy: boolean, nodes: T[]): T[] {
  if (!vibrancy) return [];
  return nodes.filter((el) => wantsNativeGlassPlate(el.className));
}
