// Terminal destacado: o arrasto da janela nativa chega ao Studio como pontos
// em pixels FISICOS da area cliente (Go). A pagina trabalha em pixels CSS.

export interface TermDragEvent {
  pane: number;
  x: number;
  y: number;
  end: boolean;
  /** botao "Encaixar" da janela: sem posicao, vai para a aba ativa */
  attach?: boolean;
}

/** Pixel fisico -> pixel CSS (devicePixelRatio). */
export function toCssPoint(x: number, y: number, dpr: number): { x: number; y: number } {
  const k = dpr > 0 ? dpr : 1;
  return { x: x / k, y: y / k };
}

/** O ponto esta' dentro da pagina? (-1 = o Go nao achou o Studio sob o cursor) */
export function pointInPage(p: { x: number; y: number }, w: number, h: number): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < w && p.y < h;
}

/** Fecha a janela destacada so' se o pane realmente entrou no layout. */
export function shouldCloseAfterDrop(inLayoutAfterDrop: boolean): boolean {
  return inLayoutAfterDrop;
}
