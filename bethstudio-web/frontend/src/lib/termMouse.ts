// Patch 0204: mouse para programas em tela cheia (login do Grok, mc, htop...).
//
// O xterm do Studio só desenha a "foto" da tela que o host manda; ele não vê o
// DECSET 1000/1002/1003 do programa. A ponte agora diz `mouse: true` no evento
// `screen` quando o programa pegou o mouse. Aí ligamos no xterm o modo 1002 +
// SGR 1006 (só para ele gerar os relatos de clique/arraste/roda), e cada relato
// SGR é convertido em `{op:"mouse"}`: o HOST codifica de novo no formato que o
// programa pediu (X10, SGR, UTF-8...).

/** Escapes que ligam/desligam a geração de relatos no xterm local. */
export const MOUSE_ON = "\x1b[?1002h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1002l\x1b[?1006l";

export type MouseKind = "press" | "release" | "move";
export type MouseButtonName = "left" | "middle" | "right" | "wheel_up" | "wheel_down" | "wheel_left" | "wheel_right" | "none";

export interface MouseReport {
  kind: MouseKind;
  button: MouseButtonName;
  /** célula, a partir de 0 */
  x: number;
  y: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

const SGR_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/**
 * Converte os relatos SGR (`ESC [ < b ; x ; y M|m`) que o xterm gerou. Devolve
 * null quando `data` não é feito só de relatos de mouse (é teclado: segue cru).
 */
export function parseSgrMouse(data: string): MouseReport[] | null {
  if (!data.startsWith("\x1b[<")) return null;
  const out: MouseReport[] = [];
  let end = 0;
  SGR_RE.lastIndex = 0;
  for (let m = SGR_RE.exec(data); m; m = SGR_RE.exec(data)) {
    if (m.index !== end) return null;
    end = m.index + m[0].length;
    const code = Number(m[1]);
    const x = Number(m[2]) - 1;
    const y = Number(m[3]) - 1;
    if (x < 0 || y < 0) return null;
    const motion = (code & 32) !== 0;
    const wheel = (code & 64) !== 0;
    const low = code & 3;
    let button: MouseButtonName;
    if (wheel) button = (["wheel_up", "wheel_down", "wheel_left", "wheel_right"] as const)[low];
    else button = (["left", "middle", "right", "none"] as const)[low];
    const kind: MouseKind = motion ? "move" : m[4] === "m" ? "release" : "press";
    out.push({ kind, button, x, y, shift: (code & 4) !== 0, alt: (code & 8) !== 0, ctrl: (code & 16) !== 0 });
  }
  return end === data.length && out.length ? out : null;
}

/** O xterm local deve gerar relatos? Só com o programa pedindo e na tela viva. */
export function wantMouse(ev: { mouse?: boolean; offset?: number }): boolean {
  return !!ev.mouse && (ev.offset ?? 0) === 0;
}
