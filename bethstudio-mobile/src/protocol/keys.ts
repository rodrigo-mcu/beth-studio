// Teclas da barra de acessorios. O host recebe bytes crus (op `send`).
// Setas em modo "normal" (CSI): a ponte manda so' a imagem da tela, sem o
// modo DECCKM do programa; bash/vim/less aceitam CSI normalmente.

export const KEY = {
  esc: "\x1b",
  tab: "\t",
  enter: "\r",
  ctrlC: "\x03",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
} as const;

export type ArrowKey = "up" | "down" | "right" | "left";

const ARROW_FINAL: Record<ArrowKey, string> = { up: "A", down: "B", right: "C", left: "D" };

/** Seta, opcionalmente com Ctrl (CSI 1;5X). */
export function arrow(key: ArrowKey, ctrl = false): string {
  return ctrl ? `\x1b[1;5${ARROW_FINAL[key]}` : `\x1b[${ARROW_FINAL[key]}`;
}

/**
 * Aplica Ctrl ao primeiro caractere digitado (Ctrl "grudado" da barra).
 * a-z/A-Z -> 0x01..0x1a; @ [ \ ] ^ _ espaco ? -> seus codigos de controle.
 * Qualquer outra coisa passa inalterada.
 */
export function applyCtrl(data: string): string {
  if (!data) return data;
  const ch = data[0]!;
  const rest = data.slice(1);
  const c = ch.charCodeAt(0);
  if ((c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a)) return String.fromCharCode(c & 0x1f) + rest;
  const map: Record<string, string> = { "@": "\x00", " ": "\x00", "[": "\x1b", "\\": "\x1c", "]": "\x1d", "^": "\x1e", _: "\x1f", "?": "\x7f" };
  const mapped = map[ch];
  return mapped !== undefined ? mapped + rest : data;
}
