// Link mágico: https://<domínio>/#pair=<token>. O token vai no fragmento (#),
// que o navegador não envia ao servidor; esta página o lê, apaga da barra e
// troca por uma sessão com um POST.

const PAIR_RE = /^[A-Za-z0-9_-]{20,200}$/;

/** Lê o token de "#pair=..." ou devolve null (fragmento ausente ou malformado). */
export function parsePairFragment(hash: string): string | null {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  for (const part of h.split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq) !== "pair") continue;
    const tok = part.slice(eq + 1);
    return PAIR_RE.test(tok) ? tok : null;
  }
  return null;
}

/** Há "pair" no fragmento (mesmo inválido)? Para mostrar o erro certo em vez do login. */
export function hasPairFragment(hash: string): boolean {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  return h.split("&").some((p) => p === "pair" || p.startsWith("pair="));
}

export type PairResult = { ok: true } | { ok: false; error: string };

/** Troca o token por sessão. Mensagens em pt-BR prontas para a tela. */
export async function exchangePair(token: string, doFetch: typeof fetch = fetch): Promise<PairResult> {
  try {
    const r = await doFetch("/api/phone/pair", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (r.ok) return { ok: true };
    if (r.status === 503) return { ok: false, error: "O computador está desconectado do servidor." };
    if (r.status === 429) return { ok: false, error: "Muitas tentativas. Espere um minuto." };
    const data = (await r.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error || "Link inválido ou expirado." };
  } catch {
    return { ok: false, error: "Sem internet ou o servidor não respondeu." };
  }
}

/** Tira o token da barra de endereço e do histórico. */
export function clearPairFragment(loc: Pick<Location, "pathname" | "search">, hist: Pick<History, "replaceState">): void {
  try {
    hist.replaceState(null, "", loc.pathname + loc.search);
  } catch {
    /* sem histórico (teste) */
  }
}
