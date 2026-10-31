// Relógio da gravação do Falar: conta só o tempo gravado, sem os trechos
// pausados. Testado em tests/recClock.test.ts.

export class RecClock {
  private startedAt: number;
  private pausedTotal = 0;
  private pausedAt: number | null = null;

  constructor(now: number) {
    this.startedAt = now;
  }

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  pause(now: number) {
    if (this.pausedAt === null) this.pausedAt = now;
  }

  resume(now: number) {
    if (this.pausedAt !== null) {
      this.pausedTotal += Math.max(0, now - this.pausedAt);
      this.pausedAt = null;
    }
  }

  /** ms gravados até `now` (congela enquanto pausado). */
  elapsed(now: number): number {
    const end = this.pausedAt ?? now;
    return Math.max(0, end - this.startedAt - this.pausedTotal);
  }
}
