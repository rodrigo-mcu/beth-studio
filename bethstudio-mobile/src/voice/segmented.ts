// Gravação em trechos. Um .m4a só vira arquivo válido quando o gravador o
// fecha; se o app morrer no meio, um arquivo único se perde. Por isso a
// gravação é cortada a cada `segmentMs`: cada trecho fechado já é um áudio
// completo no disco, e o fecha-e-abre acontece sem a pessoa perceber (o
// próximo gravador é preparado ANTES de fechar o atual).
//
// O gravador de verdade (expo-audio) entra por `create`; aqui só a lógica.

export interface RecorderLike {
  uri: string | null;
  prepareToRecordAsync(): Promise<void>;
  record(): void;
  stop(): Promise<void>;
  getStatus(): { metering?: number };
}

export interface ClosedPart {
  uri: string;
  seconds: number;
}

export interface SegmentedOptions {
  create: () => RecorderLike;
  segmentMs: number;
  now: () => number;
  /** o arquivo do trecho já existe e vai começar a gravar: persista o caminho agora */
  onSegmentOpen: (uri: string) => Promise<void>;
  /** o trecho foi fechado com a duração medida */
  onSegmentClosed: (p: ClosedPart) => Promise<void>;
}

export interface Finished {
  parts: ClosedPart[];
  seconds: number;
  /** maior valor do medidor (dB); null = sem medição */
  peakDb: number | null;
}

export class SegmentedRecorder {
  private current: RecorderLike | null = null;
  private segStart = 0;
  private parts: ClosedPart[] = [];
  private peakDb: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private rotating: Promise<void> | null = null;
  private ended = false;

  constructor(private readonly o: SegmentedOptions) {}

  async start(): Promise<void> {
    const first = this.o.create();
    await first.prepareToRecordAsync();
    if (!first.uri) throw new Error("O gravador não deu o caminho do arquivo.");
    await this.o.onSegmentOpen(first.uri);
    first.record();
    this.current = first;
    this.segStart = this.o.now();
    this.armTimer();
  }

  private armTimer() {
    if (this.ended) return;
    this.timer = setTimeout(() => {
      this.rotating = this.rotate().finally(() => {
        this.rotating = null;
      });
    }, this.o.segmentMs);
  }

  private async rotate(): Promise<void> {
    const old = this.current;
    if (!old || this.ended) return;
    try {
      const next = this.o.create();
      await next.prepareToRecordAsync();
      if (!next.uri) throw new Error("sem caminho");
      await this.o.onSegmentOpen(next.uri);
      if (this.ended) return;
      await old.stop();
      const now = this.o.now();
      const closed = { uri: old.uri ?? "", seconds: (now - this.segStart) / 1000 };
      this.parts.push(closed);
      next.record();
      this.current = next;
      this.segStart = now;
      await this.o.onSegmentClosed(closed);
    } catch {
      // Não deu para trocar de trecho (microfone ocupado...): o atual segue gravando.
    }
    this.armTimer();
  }

  /** Lê o medidor e guarda o maior pico. Devolve o valor atual (dB). */
  sampleLevel(): number | null {
    const db = this.current?.getStatus().metering;
    if (typeof db !== "number") return null;
    if (this.peakDb === null || db > this.peakDb) this.peakDb = db;
    return db;
  }

  private async finish(): Promise<Finished> {
    this.ended = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.rotating;
    const cur = this.current;
    this.current = null;
    if (cur) {
      try {
        await cur.stop();
      } catch {
        /* já parado */
      }
      const closed = { uri: cur.uri ?? "", seconds: (this.o.now() - this.segStart) / 1000 };
      this.parts.push(closed);
      await this.o.onSegmentClosed(closed).catch(() => undefined);
    }
    const seconds = this.parts.reduce((n, p) => n + p.seconds, 0);
    return { parts: this.parts.slice(), seconds, peakDb: this.peakDb };
  }

  stop(): Promise<Finished> {
    return this.finish();
  }

  /** Pára e devolve os trechos; quem chamou apaga os arquivos. */
  cancel(): Promise<Finished> {
    return this.finish();
  }
}
