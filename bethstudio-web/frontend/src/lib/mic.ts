// Microfone: escolha do dispositivo, formato de gravacao, nivel do sinal e
// log de diagnostico. Funcoes puras testadas em tests/mic.test.ts.

import type { Connection } from "./connection";

/** Microfone salvo em web-settings (voice.mic_device_id / mic_label). "" = padrao do Windows. */
export interface MicChoice {
  id: string;
  label: string;
}

export interface MicDevice {
  deviceId: string;
  label: string;
  kind: string;
}

/** Formatos tentados, em ordem. "" = deixar o navegador escolher. */
export const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

export function pickMimeType(isSupported: (m: string) => boolean): string {
  for (const m of MIME_CANDIDATES) {
    try {
      if (isSupported(m)) return m;
    } catch {
      /* navegador sem isTypeSupported */
    }
  }
  return "";
}

/** Entradas de audio reais (sem as entradas virtuais "default"/"communications"). */
export function audioInputs(devices: MicDevice[]): MicDevice[] {
  return devices.filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications");
}

/**
 * Reencontra o microfone salvo: pelo id; se o id mudou (o Chromium troca
 * ids quando os dados do site sao limpos), pelo nome. Nao achou = padrao.
 */
export function resolveMic(devices: MicDevice[], saved: MicChoice | undefined): { deviceId: string; label: string; found: boolean } {
  if (!saved || !saved.id) return { deviceId: "", label: "", found: true };
  const ins = audioInputs(devices);
  const byId = ins.find((d) => d.deviceId === saved.id);
  if (byId) return { deviceId: byId.deviceId, label: byId.label || saved.label, found: true };
  const byLabel = saved.label ? ins.find((d) => d.label === saved.label) : undefined;
  if (byLabel) return { deviceId: byLabel.deviceId, label: byLabel.label, found: true };
  return { deviceId: "", label: "", found: false };
}

export function audioConstraints(deviceId: string): MediaTrackConstraints {
  const base: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  return deviceId ? { ...base, deviceId: { exact: deviceId } } : base;
}

/** Nivel 0..1 (RMS amplificado) de uma amostra getByteTimeDomainData. */
export function rmsLevel(buf: ArrayLike<number>): number {
  if (!buf.length) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += ((buf[i] - 128) / 128) ** 2;
  return Math.min(1, Math.sqrt(sum / buf.length) * 4);
}

export const SILENCE_LEVEL = 0.02;
export const SILENCE_MS = 3000;

/** "Nenhum som captado": nivel abaixo do limiar por `ms` seguidos. */
export class SilenceWatch {
  private since: number | null = null;
  private threshold: number;
  private ms: number;
  constructor(threshold = SILENCE_LEVEL, ms = SILENCE_MS) {
    this.threshold = threshold;
    this.ms = ms;
  }
  /** true enquanto o silencio ja' durou `ms` ou mais. */
  feed(level: number, now: number): boolean {
    if (level >= this.threshold) {
      this.since = null;
      return false;
    }
    if (this.since === null) this.since = now;
    return now - this.since >= this.ms;
  }
}

/** Resultado do "Testar microfone" (pico de nivel em 5 s). */
export function testVerdict(peak: number): { ok: boolean; text: string } {
  return peak >= 0.08
    ? { ok: true, text: `Sinal ok (pico ${Math.round(peak * 100)}%)` }
    : peak >= SILENCE_LEVEL
      ? { ok: true, text: `Sinal fraco (pico ${Math.round(peak * 100)}%) — fale mais perto ou aumente o volume de entrada` }
      : { ok: false, text: "Sem sinal — o microfone está mudo ou é o microfone errado?" };
}

/** Problema com o audio gravado (null = ok). */
export function blobProblem(size: number, chunks: number): string | null {
  if (size === 0)
    return chunks === 0
      ? "Nenhum áudio foi gravado (o gravador não entregou dados). Tente outro microfone ou “Testar microfone” em Configurações."
      : "O áudio gravado veio vazio (0 bytes). Tente outro microfone.";
  if (size < 100) return `O áudio gravado é pequeno demais (${size} bytes) para transcrever.`;
  return null;
}

/** Passo do microfone: console + log do Go (/api/log). Texto curto, sem conteudo. */
export function micLog(conn: Connection, msg: string) {
  const line = `mic: ${msg}`;
  console.info(line);
  void conn.api("/api/log", { msg: line }).catch(() => undefined);
}

/** Nome amigavel (os nomes so' aparecem depois da permissao). */
export function micLabel(d: MicDevice, index: number): string {
  return d.label || `Microfone ${index + 1}`;
}
