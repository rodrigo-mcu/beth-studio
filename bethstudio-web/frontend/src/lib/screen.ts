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
  cols?: number;
}

const ESC = "\x1b";
// SGR 0 nao fecha hyperlink (OSC 8): sem isto, uma ultima linha que termina
// dentro de um link faria o link vazar para a linha 0 do quadro seguinte.
const CLOSE_LINK = `${ESC}]8;;${ESC}\\`;

export function screenWrite(ev: ScreenLike): string {
  const rows = ev.text.split("\r\n");
  const max = ev.rows && ev.rows > 0 ? ev.rows : rows.length;
  let out = `${ESC}[?7l${ESC}[0m${CLOSE_LINK}${ESC}[H${ESC}[2J`;
  for (let i = 0; i < rows.length && i < max; i++) {
    out += `${ESC}[${i + 1};1H${rows[i]}`;
  }
  out += `${ESC}[0m${CLOSE_LINK}${ESC}[${ev.cursor_y + 1};${ev.cursor_x + 1}H${ev.cursor_visible ? `${ESC}[?25h` : `${ESC}[?25l`}`;
  return out;
}

// --- escrita incremental ---------------------------------------------------
//
// Reescrever a tela inteira a cada quadro obriga o xterm a refazer todas as
// linhas (no renderizador DOM, todos os elementos). Em PC fraco isso pesa. O
// escritor abaixo manda so' as linhas que mudaram.
//
// Cuidado: o host emite cada linha RELATIVA ao estado (SGR e hyperlink OSC 8)
// em que a linha anterior terminou (lines_to_escapes). Escrever a linha i
// sozinha daria cor errada. Por isso guardamos, por linha, a "cauda" do estado
// (as sequencias SGR desde o ultimo reset e o ultimo hyperlink) e a repetimos
// antes da linha que mudou. Nao interpretamos cor nenhuma: so' repetimos os
// mesmos bytes que o host mandou.

// ESC [ <params> m  (inclui sub-parametros com ':')
const SGR = /\x1b\[([0-9;:]*)m/g;
// ESC ] 8 ; <params> ; <uri> (BEL | ESC \)
const OSC8 = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/** Cauda maior que isto: desiste do incremental neste quadro (escrita completa). */
const MAX_TAIL = 2048;
/** A cada N quadros incrementais, uma escrita completa limpa qualquer desvio. */
const FULL_EVERY = 300;

interface Tail {
  sgr: string; // sequencias SGR a repetir (depois de um reset)
  link: string; // ultimo OSC 8 aberto ("" = nenhum)
}

const EMPTY_TAIL: Tail = { sgr: "", link: "" };

function isReset(params: string): boolean {
  return params === "" || params === "0";
}

/** Estado ao final de `row`, partindo do estado `from` ao inicio dela. */
export function tailAfter(from: Tail, row: string): Tail {
  // Ordem dos eventos importa pouco entre SGR e OSC 8 (sao estados independentes),
  // mas dentro de cada tipo a ordem e' a do texto.
  let sgr = from.sgr;
  SGR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SGR.exec(row)) !== null) {
    if (isReset(m[1])) sgr = "";
    else if (m[1].startsWith("0;")) sgr = m[0];
    else sgr += m[0];
  }
  let link = from.link;
  OSC8.lastIndex = 0;
  while ((m = OSC8.exec(row)) !== null) {
    link = m[1] === "" ? "" : m[0];
  }
  return { sgr, link };
}

function restore(t: Tail): string {
  return `${ESC}[0m${CLOSE_LINK}${t.link}${t.sgr}`;
}

export interface ScreenWriter {
  /** Dados para o xterm.write deste quadro. */
  write(ev: ScreenLike): string;
  /** O xterm foi reiniciado/redimensionado por fora: o proximo quadro e' completo. */
  reset(): void;
}

/** incremental=false: sempre a escrita completa (valvula de escape; ver termRenderer.readIncrementalWrite). */
export function createScreenWriter(incremental = true): ScreenWriter {
  let prev: string[] | null = null;
  let prevCols = -1;
  let sinceFull = 0;

  const full = (ev: ScreenLike, rows: string[]): string => {
    prev = rows;
    prevCols = ev.cols ?? -1;
    sinceFull = 0;
    return screenWrite(ev);
  };

  return {
    reset() {
      prev = null;
    },
    write(ev) {
      if (!incremental) return screenWrite(ev);
      const all = ev.text.split("\r\n");
      const max = ev.rows && ev.rows > 0 ? ev.rows : all.length;
      const rows = all.length > max ? all.slice(0, max) : all;
      if (!prev || prev.length !== rows.length || (ev.cols ?? -1) !== prevCols || sinceFull >= FULL_EVERY) return full(ev, rows);

      let out = "";
      let t = EMPTY_TAIL;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i] !== prev[i]) {
          // estado ao inicio da linha i = fim da linha i-1 (ja' calculado agora)
          out += `${ESC}[0m${ESC}[${i + 1};1H${ESC}[2K${restore(t)}${rows[i]}`;
        }
        t = tailAfter(t, rows[i]);
        if (t.sgr.length + t.link.length > MAX_TAIL) return full(ev, rows);
      }
      prev = rows;
      sinceFull++;
      // DECAWM continua desligado da escrita completa; so' reposiciona o cursor.
      return `${ESC}[?7l${out}${ESC}[0m${ESC}[${ev.cursor_y + 1};${ev.cursor_x + 1}H${ev.cursor_visible ? `${ESC}[?25h` : `${ESC}[?25l`}`;
    },
  };
}
