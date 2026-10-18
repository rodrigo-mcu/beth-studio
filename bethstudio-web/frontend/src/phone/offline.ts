// Tela "O computador está desconectado": quando o PC foi visto pela última vez.

/** Corpo do 503 do proxy em /api/*: {offline:true, last_seen:"RFC3339"} (last_seen pode faltar). */
export function parseLastSeen(body: unknown): Date | null {
  if (!body || typeof body !== "object") return null;
  const v = (body as { last_seen?: unknown }).last_seen;
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const z = (n: number) => String(n).padStart(2, "0");

/** "Visto pela última vez às 14:32 de 17/10", no fuso do aparelho. null = sem hora. */
export function formatLastSeen(d: Date | null): string | null {
  if (!d) return null;
  return `Visto pela última vez às ${z(d.getHours())}:${z(d.getMinutes())} de ${z(d.getDate())}/${z(d.getMonth() + 1)}`;
}

/** Nova tentativa automática da tela offline. */
export const OFFLINE_RETRY_MS = 15000;
