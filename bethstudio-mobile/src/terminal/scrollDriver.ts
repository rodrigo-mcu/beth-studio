// Rolagem do historico (op `scroll`, patch 0171), igual ao bethstudio-web:
// deltas acumulados, no maximo um envio a cada 30 ms, limite no scrollback.

export interface ScrollView3 {
  offset: number;
  scrollback: number;
  rows: number;
}

export class ScrollDriver {
  cur: ScrollView3 = { offset: 0, scrollback: 0, rows: 24 };
  private desired: number | null = null;
  private lastSent = -1;
  private lastSentAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly sendScroll: (offset: number) => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Nova tela da ponte. Devolve true se offset/scrollback/rows mudaram. */
  onScreen(ev: { offset: number; scrollback: number; rows: number }): boolean {
    if (this.desired !== null && this.desired === ev.offset && this.timer === undefined) this.desired = null;
    const changed = ev.offset !== this.cur.offset || ev.scrollback !== this.cur.scrollback || ev.rows !== this.cur.rows;
    this.cur = { offset: ev.offset, scrollback: ev.scrollback, rows: ev.rows };
    return changed;
  }

  /** Linhas positivas = mais para tras no historico. */
  scrollBy(lines: number) {
    if (!lines) return;
    this.scrollTo((this.desired ?? this.cur.offset) + lines);
  }

  scrollTo(offset: number) {
    const max = this.cur.scrollback > 0 ? this.cur.scrollback : 1_000_000;
    this.desired = Math.max(0, Math.min(max, Math.round(offset)));
    if (this.timer === undefined) {
      this.timer = setTimeout(() => this.flush(), Math.max(0, 30 - (this.now() - this.lastSentAt)));
    }
  }

  /** Digitar volta ao fim (a ponte faz isso sozinha no send/paste). */
  resetToLive() {
    this.desired = null;
    this.lastSent = 0;
  }

  dispose() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private flush() {
    this.timer = undefined;
    if (this.desired === null || this.desired === this.lastSent) return;
    this.lastSent = this.desired;
    this.lastSentAt = this.now();
    this.sendScroll(this.desired);
  }
}
