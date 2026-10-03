// "Ajustar a' janela": o web muda cols x rows do pane NO HOST (ponte, patch
// 0178) para caber na area com a fonte atual. Funcoes puras testadas em
// tests/hostFit.test.ts.

import type { PaneInfo } from "./types";

export interface GridSize {
  cols: number;
  rows: number;
}

export const GRID_LIMITS = { minCols: 10, maxCols: 500, minRows: 4, maxRows: 300 };

/** cols/rows que cabem em w x h px com a celula real medida do xterm. */
export function gridFor(w: number, h: number, cellW: number, cellH: number): GridSize | null {
  if (!(cellW > 0) || !(cellH > 0) || !(w > 0) || !(h > 0)) return null;
  const L = GRID_LIMITS;
  return {
    cols: Math.max(L.minCols, Math.min(L.maxCols, Math.floor(w / cellW + 1e-6))),
    rows: Math.max(L.minRows, Math.min(L.maxRows, Math.floor(h / cellH + 1e-6))),
  };
}

/** A ponte so' redimensiona panes sozinhos na aba do host. */
export function aloneInHostTab(panes: PaneInfo[] | null, paneId: number): boolean {
  if (!panes) return false;
  const me = panes.find((p) => p.pane_id === paneId);
  if (!me) return false;
  return panes.filter((p) => p.tab_id === me.tab_id).length === 1;
}

export type SizeMode = "fit" | "host";

/** Modo efetivo: salvo por pane; padrao "fit" se sozinho na aba do host. */
export function effectiveSizeMode(saved: string | undefined, alone: boolean): SizeMode {
  if (!alone) return "host";
  return saved === "host" ? "host" : "fit";
}

const same = (a: GridSize | null | undefined, b: GridSize | null | undefined) => !!a && !!b && a.cols === b.cols && a.rows === b.rows;

/**
 * Regra anti-briga com a GUI:
 *  - so' pede resize por um motivo do web (area mudou, fonte mudou, abriu,
 *    ou o botao "Reajustar");
 *  - nao repete o mesmo pedido enquanto espera o host aplicar;
 *  - se o host mudar o tamanho por conta propria (GUI) depois que o nosso
 *    pedido foi aplicado, NAO reenvia: marca `divergent` (a UI mostra
 *    "Reajustar a esta janela").
 */
export class FitGovernor {
  lastSent: GridSize | null = null;
  pendingUntil = 0;
  divergent = false;
  /** 3 reajustes automaticos em 30 s: a GUI esta' brigando pelo tamanho. */
  fighting = false;
  private autoTimes: number[] = [];

  static readonly PENDING_MS = 1500;
  static readonly AUTO_MIN_GAP_MS = 3000;
  static readonly AUTO_WINDOW_MS = 30000;
  static readonly AUTO_MAX = 3;

  /**
   * O host mudou o tamanho e o web esta' com foco: pode reajustar sozinho?
   * No maximo 1 vez a cada 3 s; 3 vezes em 30 s => para (fighting) e so'
   * o botao "Reajustar" volta a ajustar.
   */
  autoRefit(now: number, focused: boolean): boolean {
    if (!this.divergent || !focused || this.fighting) return false;
    this.autoTimes = this.autoTimes.filter((t) => now - t < FitGovernor.AUTO_WINDOW_MS);
    const last = this.autoTimes[this.autoTimes.length - 1];
    if (last !== undefined && now - last < FitGovernor.AUTO_MIN_GAP_MS) return false;
    if (this.autoTimes.length >= FitGovernor.AUTO_MAX) {
      this.fighting = true;
      return false;
    }
    this.autoTimes.push(now);
    return true;
  }

  /** Devolve o tamanho a enviar agora, ou null. */
  request(desired: GridSize, host: GridSize, reason: "area" | "font" | "open" | "manual" | "auto", now: number): GridSize | null {
    if (reason === "manual") {
      this.fighting = false;
      this.autoTimes = [];
    }
    if (same(desired, host)) {
      this.lastSent = desired;
      this.pendingUntil = 0;
      this.divergent = false;
      return null;
    }
    if (reason !== "manual" && same(desired, this.lastSent) && now < this.pendingUntil) return null;
    this.lastSent = desired;
    this.pendingUntil = now + FitGovernor.PENDING_MS;
    this.divergent = false;
    return desired;
  }

  /** Tamanho que chegou do host (evento screen). */
  hostSize(host: GridSize, now: number): void {
    if (!this.lastSent) return;
    if (same(host, this.lastSent)) {
      this.pendingUntil = 0;
      this.divergent = false;
      return;
    }
    // Ainda esperando o host aplicar: telas antigas nao contam.
    if (now < this.pendingUntil) return;
    this.divergent = true;
  }
}

/** "resize: pane 10 shares its BethTerm tab with 1 other pane(s)" -> 10 */
export function resizeRefusedPane(message: string): number | null {
  const m = /^resize: pane (\d+) shares its BethTerm tab/.exec(message);
  return m ? Number(m[1]) : null;
}

/**
 * Fonte que cabe na LARGURA (nunca um grid mais largo que a area):
 * parte da preferida e so' reduz quando precisa (degraus de 0,5 px, min 5).
 * `widthAtCurrent` = largura do grid com a fonte `current`.
 */
export function fontForWidth(preferred: number, current: number, widthAtCurrent: number, available: number): number {
  if (!(widthAtCurrent > 0) || !(available > 0) || !(current > 0)) return preferred;
  const perPx = widthAtCurrent / current; // largura do grid por px de fonte
  const fit = Math.floor((available / perPx) * 2) / 2;
  return Math.max(5, Math.min(preferred, fit));
}
