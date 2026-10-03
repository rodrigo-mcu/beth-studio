// Gravação no celular. Grava ao mesmo tempo pelo MediaRecorder (arquivo
// pequeno) e pelo Web Audio (PCM → WAV), mostra o nível real do microfone e,
// no fim, escolhe o arquivo que tem som (ver chooseTake em audio.ts).

import { pickMimeType } from "@/lib/mic";
import { chooseTake, Downsampler, encodeWav, meterLevel, peakOf, type TakeChoice } from "./audio";

type AC = typeof AudioContext;

export interface Recording {
  blob: Blob;
  seconds: number;
  choice: TakeChoice;
}

/** Mensagem clara para cada falha de getUserMedia. */
export function micErrorText(e: unknown): string {
  const name = (e as DOMException)?.name ?? "";
  if (!window.isSecureContext) return "O microfone só funciona com https. Abra pelo endereço https do Beth Studio.";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "O microfone está bloqueado para este site. Libere em Ajustes do navegador → Microfone e toque em Falar de novo.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "Nenhum microfone encontrado neste aparelho.";
    case "NotReadableError":
    case "AbortError":
      return "Outro app está usando o microfone (ligação, gravador). Feche e tente de novo.";
  }
  return (e as Error)?.message || "Não deu para abrir o microfone.";
}

export class PhoneRecorder {
  private ctx: AudioContext | null;
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private ds: Downsampler | null = null;
  private peak = 0;
  private t0 = 0;
  private stopped = false;

  /**
   * Chame direto no toque do botão: o AudioContext nasce antes de qualquer
   * await, senão o iPhone o deixa suspenso.
   */
  constructor(private onLevel: (level: number) => void) {
    const Ctor: AC | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: AC }).webkitAudioContext;
    this.ctx = Ctor ? new Ctor() : null;
    void this.ctx?.resume().catch(() => undefined);
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(window.isSecureContext ? "Este navegador não grava áudio." : micErrorText(null));
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (e) {
      this.dispose();
      throw new Error(micErrorText(e));
    }
    if (this.stopped) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    this.t0 = performance.now();

    const ctx = this.ctx;
    if (ctx) {
      if (ctx.state !== "running") await ctx.resume().catch(() => undefined);
      const src = ctx.createMediaStreamSource(stream);
      // ScriptProcessor: funciona em todo navegador de celular sem arquivo de worklet.
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      this.ds = new Downsampler(ctx.sampleRate);
      proc.onaudioprocess = (ev) => {
        if (this.stopped) return;
        const data = ev.inputBuffer.getChannelData(0);
        const p = peakOf(data);
        if (p > this.peak) this.peak = p;
        this.ds?.push(data);
        this.onLevel(meterLevel(p));
      };
      src.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      this.nodes = [src, proc, mute];
    }

    if (typeof MediaRecorder !== "undefined") {
      try {
        const mime = pickMimeType((m) => MediaRecorder.isTypeSupported(m));
        // No Safari, forçar audio/mp4 não ajuda; deixa o padrão dele.
        const rec = new MediaRecorder(stream, mime && mime !== "audio/mp4" ? { mimeType: mime } : undefined);
        rec.ondataavailable = (e) => {
          if (e.data.size) this.chunks.push(e.data);
        };
        // Em fatias: o iPhone às vezes só entrega dados assim.
        rec.start(1000);
        this.rec = rec;
      } catch {
        this.rec = null;
      }
    }
  }

  get elapsedMs() {
    return this.t0 ? performance.now() - this.t0 : 0;
  }

  async stop(): Promise<Recording> {
    const seconds = this.elapsedMs / 1000;
    this.stopped = true;
    const rec = this.rec;
    if (rec && rec.state !== "inactive") {
      await new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
        try {
          rec.requestData();
        } catch {
          /* sem requestData */
        }
        rec.stop();
        window.setTimeout(resolve, 1500);
      });
    }
    const type = rec?.mimeType || this.chunks[0]?.type || "audio/webm";
    const recorderBlob = new Blob(this.chunks, { type });
    const pcm = this.ds?.samples() ?? new Float32Array(0);
    this.dispose();
    const choice = chooseTake({ seconds, recorderBytes: recorderBlob.size, pcmSamples: pcm.length, peak: this.peak });
    if (choice === "recorder") return { blob: recorderBlob, seconds, choice };
    if (choice === "wav") return { blob: new Blob([encodeWav(pcm)], { type: "audio/wav" }), seconds, choice };
    return { blob: new Blob([]), seconds, choice };
  }

  cancel() {
    this.stopped = true;
    try {
      if (this.rec && this.rec.state !== "inactive") this.rec.stop();
    } catch {
      /* já parado */
    }
    this.dispose();
  }

  private dispose() {
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* já desligado */
      }
    }
    this.nodes = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
