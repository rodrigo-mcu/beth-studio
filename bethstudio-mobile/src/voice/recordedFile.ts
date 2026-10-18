// Escolha do arquivo gravado e detecção de silêncio. Funções puras (a leitura
// do tamanho no disco fica em quem chama). Mesma ideia de chooseTake no web
// (phone/audio.ts): arquivo oco não sobe.

/** Bytes por segundo abaixo do qual o arquivo é considerado oco (AAC mono ~3 KB/s). */
export const MIN_BYTES_PER_SEC = 1000;

/** Pico do medidor (dB) abaixo do qual nada foi captado. */
export const SILENT_PEAK_DB = -55;

export interface Candidate {
  uri: string | null;
  bytes: number;
}

/** O primeiro candidato com som de verdade, ou null se todos vieram ocos. */
export function pickRecordedFile(candidates: Candidate[], seconds: number): string | null {
  const need = Math.max(2000, seconds * MIN_BYTES_PER_SEC);
  for (const c of candidates) {
    if (c.uri && c.bytes >= need) return c.uri;
  }
  return null;
}

/** Silêncio total? `peakDb` é o maior valor do medidor na gravação (null = sem medição). */
export function isSilent(peakDb: number | null): boolean {
  return peakDb !== null && peakDb < SILENT_PEAK_DB;
}

/** Medidor (dB) para barra 0..1, com a fala visível. */
export function meterLevel(db: number | null | undefined): number {
  if (db === null || db === undefined || !Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db + 60) / 60));
}
