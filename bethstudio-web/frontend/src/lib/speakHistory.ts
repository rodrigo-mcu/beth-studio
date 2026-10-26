// Histórico das transcrições do popup "Falar" (SpeakDialog). Cada fala é
// guardada assim que a transcrição termina, ANTES de enviar ao terminal: se o
// envio falhar ou o agente cortar o texto, o usuário copia daqui. Funções
// puras; testadas em tests/speakHistory.test.ts.

export const SPEAK_HISTORY_KEY = "bt.speak.history";
export const SPEAK_HISTORY_MAX = 20;

export interface SpeakEntry {
  id: string;
  /** epoch ms */
  at: number;
  /** texto final (corrigido ou original, como o usuário o deixou) */
  text: string;
  /** texto bruto do provedor, quando difere de `text` */
  original?: string;
  /** rótulo do terminal de destino */
  target: string;
  sent: boolean;
}

export function isEntry(v: unknown): v is SpeakEntry {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.at === "number" &&
    Number.isFinite(r.at) &&
    typeof r.text === "string" &&
    typeof r.target === "string" &&
    typeof r.sent === "boolean" &&
    (r.original === undefined || typeof r.original === "string")
  );
}

export function isEntryList(v: unknown): v is SpeakEntry[] {
  return Array.isArray(v) && v.every(isEntry);
}

/** Mais recente primeiro; só as `max` últimas. Texto vazio não entra. */
export function addEntry(list: SpeakEntry[], e: SpeakEntry, max = SPEAK_HISTORY_MAX): SpeakEntry[] {
  if (!e.text.trim()) return list;
  return [e, ...list.filter((x) => x.id !== e.id)].slice(0, max);
}

/** Atualiza uma fala já guardada (texto editado, marcada como enviada). */
export function updateEntry(list: SpeakEntry[], id: string, patch: Partial<Pick<SpeakEntry, "text" | "sent">>): SpeakEntry[] {
  return list.map((x) => (x.id === id ? { ...x, ...patch } : x));
}

export function removeEntry(list: SpeakEntry[], id: string): SpeakEntry[] {
  return list.filter((x) => x.id !== id);
}

export function newEntryId(now = Date.now()): string {
  return `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Uma linha para a lista recolhida. */
export function preview(text: string, n = 90): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
