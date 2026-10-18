// Sessão do celular: saber se já entrou, entrar e sair. O app (HTML, JS,
// manifesto) é público; só /api e /ws exigem a senha ou o aparelho pareado.

import { parseLastSeen } from "./offline";

/** in = entrou; login = pedir senha; offline = o PC não está ligado ao servidor; local = aberto neste PC (token do Studio). */
export type SessionState = "checking" | "in" | "login" | "offline" | "local";

export type SessionDetail = { state: SessionState; lastSeen: Date | null };

/** Como checkSession, mais a hora em que o proxy viu o PC pela última vez (quando offline). */
export async function checkSessionDetail(): Promise<SessionDetail> {
  try {
    const r = await fetch("/api/phone/me", { credentials: "same-origin", cache: "no-store" });
    if (r.ok) return { state: "in", lastSeen: null };
    if (r.status === 401) return { state: "login", lastSeen: null };
    // O Studio neste PC não tem essa rota: página aberta localmente para teste.
    if (r.status === 404 && (location.hostname === "127.0.0.1" || location.hostname === "localhost")) {
      return { state: "local", lastSeen: null };
    }
    const body: unknown = r.status === 503 ? await r.json().catch(() => null) : null;
    return { state: "offline", lastSeen: parseLastSeen(body) };
  } catch {
    return { state: "offline", lastSeen: null };
  }
}

export async function checkSession(): Promise<SessionState> {
  return (await checkSessionDetail()).state;
}

export async function login(password: string): Promise<string | null> {
  try {
    const r = await fetch("/api/phone/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (r.ok) return null;
    if (r.status === 503) return "O computador está desconectado do servidor.";
    const data = (await r.json().catch(() => ({}))) as { error?: string };
    return data.error || "Senha não aceita.";
  } catch {
    return "Sem internet ou o servidor não respondeu.";
  }
}

export async function logout(): Promise<void> {
  await fetch("/api/phone/logout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
}
