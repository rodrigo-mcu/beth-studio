// Como uma tela da ponte vira escrita no xterm.js.
//
// O texto chega como linhas SGR separadas por CRLF. Se o xterm medir um
// caractere mais largo que o host (emoji, simbolos), uma linha passaria do
// limite e, com autowrap ligado, QUEBRARIA, empurrando tudo para baixo e
// cortando a ultima linha. Por isso: autowrap (DECAWM) desligado e cada
// linha posicionada explicitamente em (i+1, 1). O estado SGR e' sequencial,
// entao escrever as linhas na ordem preserva as cores.

export interface ScreenLike {
  text: string;
  cursor_x: number;
  cursor_y: number;
  cursor_visible: boolean;
  rows?: number;
}

const ESC = "\x1b";

export function screenWrite(ev: ScreenLike): string {
  const rows = ev.text.split("\r\n");
  const max = ev.rows && ev.rows > 0 ? ev.rows : rows.length;
  let out = `${ESC}[?7l${ESC}[0m${ESC}[H${ESC}[2J`;
  for (let i = 0; i < rows.length && i < max; i++) {
    out += `${ESC}[${i + 1};1H${rows[i]}`;
  }
  out += `${ESC}[0m${ESC}[${ev.cursor_y + 1};${ev.cursor_x + 1}H${ev.cursor_visible ? `${ESC}[?25h` : `${ESC}[?25l`}`;
  return out;
}
