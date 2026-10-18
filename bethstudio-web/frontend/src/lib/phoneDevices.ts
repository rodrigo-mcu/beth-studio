// Configurações → Celular → Aparelhos: lógica pura (relógio, estados do QR).

export type PhoneDevice = {
  id: string;
  name: string;
  created: string;
  last_used: string;
  last_ip: string;
};

export type DevicesView = {
  devices: PhoneDevice[];
  pending: number;
  configured: boolean;
  domain: string;
};

export type Pairing = {
  link: string;
  qr: string;
  expires_at: string;
};

/** "agora", "há 5 min", "há 3 h", "há 2 dias". */
export function agoLabel(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "agora";
  const m = Math.floor(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "há 1 dia" : `há ${d} dias`;
}

/** Tempo que falta para o link vencer, "4:32"; null quando já venceu. */
export function countdownLabel(expiresAt: string, now: number): string | null {
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return null;
  const s = Math.ceil((t - now) / 1000);
  if (s <= 0) return null;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Estado do bloco "Conectar um celular".
 * idle: sem QR; waiting: QR valendo e ninguém usou; used: o link foi usado
 * (pendentes zerou antes de vencer); expired: venceu sem uso.
 */
export type PairingState = "idle" | "waiting" | "used" | "expired";

export function pairingState(p: Pairing | null, pending: number, now: number): PairingState {
  if (!p) return "idle";
  const expired = countdownLabel(p.expires_at, now) === null;
  if (pending > 0) return expired ? "expired" : "waiting";
  return expired ? "expired" : "used";
}

/** Nome do aparelho para a lista: nunca vazio. */
export function deviceTitle(d: Pick<PhoneDevice, "name">): string {
  return d.name.trim() || "Celular";
}
