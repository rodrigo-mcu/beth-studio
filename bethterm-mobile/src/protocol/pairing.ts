import { parseServerUrl } from "./url";

// QR de pareamento (ver docs/REMOTE_ACCESS.md). Dois formatos aceitos:
//   bethterm://pair?v=1&url=<wss://...>&token=<...>&name=<...>&pin=<sha256>&ro=1
//   {"bethterm":1,"url":"wss://...","token":"...","name":"...","pin":"...","ro":true}

export interface PairingInfo {
  name: string;
  url: string;
  token: string;
  /** Pin SHA-256 da chave publica do certificado (base64), se houver. */
  pin: string | null;
  readOnly: boolean;
}

export const MIN_TOKEN_LENGTH = 16;

export function validateToken(token: string): string | null {
  const t = token.trim();
  if (t.length < MIN_TOKEN_LENGTH) return `O token precisa ter pelo menos ${MIN_TOKEN_LENGTH} caracteres.`;
  if (!/^[A-Za-z0-9_\-.~+/=]+$/.test(t)) return "O token tem caracteres inválidos.";
  return null;
}

function finish(raw: { url?: unknown; token?: unknown; name?: unknown; pin?: unknown; ro?: unknown }): PairingInfo {
  if (typeof raw.url !== "string" || typeof raw.token !== "string") throw new Error("QR code sem endereço ou token.");
  const ep = parseServerUrl(raw.url);
  const tokErr = validateToken(raw.token);
  if (tokErr) throw new Error(tokErr);
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 60) : ep.host;
  const pin = typeof raw.pin === "string" && /^[A-Za-z0-9+/=]{43,44}$/.test(raw.pin) ? raw.pin : null;
  // Somente leitura e' o padrao: so' desliga se o QR disser explicitamente.
  const readOnly = !(raw.ro === false || raw.ro === "0" || raw.ro === 0);
  return { name, url: ep.wsUrl, token: raw.token.trim(), pin, readOnly };
}

export function parsePairingPayload(data: string): PairingInfo {
  const s = data.trim();
  if (s.startsWith("{")) {
    let o: unknown;
    try {
      o = JSON.parse(s);
    } catch {
      throw new Error("QR code inválido.");
    }
    if (typeof o !== "object" || o === null || (o as { bethterm?: unknown }).bethterm !== 1) throw new Error("Este QR code não é do BethTerm.");
    return finish(o as Record<string, unknown>);
  }
  const m = /^bethterm:\/\/pair\?(.*)$/i.exec(s);
  if (!m) throw new Error("Este QR code não é do BethTerm.");
  const q = new Map<string, string>();
  for (const part of m[1]!.split("&")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    try {
      q.set(decodeURIComponent(part.slice(0, i)), decodeURIComponent(part.slice(i + 1).replace(/\+/g, " ")));
    } catch {
      throw new Error("QR code inválido.");
    }
  }
  if (q.get("v") !== "1") throw new Error("Versão de QR code não suportada.");
  return finish({ url: q.get("url"), token: q.get("token"), name: q.get("name"), pin: q.get("pin"), ro: q.get("ro") ?? undefined });
}
