// Voz: transcricao e correcao (com streaming, prazo, cancelamento e custo),
// usadas pelo popup "Falar" e pelo "Testar tudo". Funcoes puras testadas em
// tests/voicePipeline.test.ts.

import type { Connection } from "./connection";

export interface TranscribeResult {
  text: string;
  ms: number;
  ttfb_ms: number;
  provider: string;
  model: string;
  audio_sec: number;
  bytes: number;
  route?: string;
  cost_usd: number;
  cost_estimated: boolean;
}

export interface CorrectResult {
  text: string;
  ms: number;
  ttfb_ms: number;
  provider: string;
  model: string;
  in_tokens: number;
  out_tokens: number;
  cost_usd: number;
  cost_estimated: boolean;
}

/** Tipo do erro (o Go classifica em "kind"; ver voicestream.go/classifyVoiceError). */
export type VoiceErrorKind = "" | "auth" | "rate_limit" | "timeout" | "network" | "canceled" | "empty" | "other";

/** Erro com o motivo: prazo estourado, cancelado pelo usuario, chave invalida etc. */
export class VoiceError extends Error {
  timeout: boolean;
  canceled: boolean;
  kind: VoiceErrorKind;
  constructor(msg: string, opts: { timeout?: boolean; canceled?: boolean; kind?: VoiceErrorKind } = {}) {
    super(msg);
    this.kind = opts.kind ?? (opts.timeout ? "timeout" : opts.canceled ? "canceled" : "");
    this.timeout = !!opts.timeout || this.kind === "timeout";
    this.canceled = !!opts.canceled || this.kind === "canceled";
  }
}

export const DEFAULT_CORRECT_TIMEOUT_S = 30;
/** A UI desiste um pouco depois do Go (que ja' corta no prazo). */
export const UI_GRACE_MS = 3000;

export function correctTimeoutMs(sec: number | undefined): number {
  return (sec && sec >= 5 ? sec : DEFAULT_CORRECT_TIMEOUT_S) * 1000;
}

/** Separa linhas NDJSON completas; o resto fica para o proximo pedaco. */
export function parseNDJSON(buffer: string): { events: Record<string, unknown>[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const events: Record<string, unknown>[] = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t) as Record<string, unknown>);
    } catch {
      /* linha quebrada: ignora */
    }
  }
  return { events, rest };
}

function isAbort(e: unknown) {
  return (e as DOMException)?.name === "AbortError";
}

export async function transcribe(
  conn: Connection,
  audio: Blob,
  opts: { signal?: AbortSignal; audioMs?: number; pane?: number; test?: boolean; route?: "openai" | "native" } = {},
): Promise<TranscribeResult> {
  const headers: Record<string, string> = {};
  if (opts.route) headers["X-Route"] = opts.route;
  if (opts.audioMs) headers["X-Audio-Ms"] = String(Math.round(opts.audioMs));
  if (opts.pane !== undefined) headers["X-Pane-Id"] = String(opts.pane);
  if (opts.test) headers["X-Voice-Test"] = "1";
  try {
    return await conn.upload<TranscribeResult>("/api/voice/transcribe", audio, audio.type || "audio/webm", { signal: opts.signal, headers });
  } catch (e) {
    if (isAbort(e)) throw new VoiceError("transcrição cancelada", { canceled: true });
    const kind = (e as { kind?: VoiceErrorKind }).kind;
    throw new VoiceError((e as Error).message, { kind });
  }
}

/**
 * O que oferecer depois de um erro: se a chave e' o problema, so' faz
 * sentido ir configurar (tentar de novo repetiria o mesmo erro); senao,
 * "tentar de novo" reenvia o MESMO audio quando ele ainda existe (nao
 * gravado de novo), e "gravar de novo" sempre fica disponivel.
 */
export function errorRecovery(kind: VoiceErrorKind, hasAudio: boolean): { retry: boolean; rerecord: boolean; authRequired: boolean } {
  if (kind === "auth") return { retry: false, rerecord: false, authRequired: true };
  return { retry: hasAudio, rerecord: true, authRequired: false };
}

/**
 * Correcao com streaming: onDelta recebe o texto chegando. `timeoutMs` e' o
 * prazo configurado; a UI desiste em timeoutMs + UI_GRACE_MS se o Go nao
 * responder. `signal` cancela (Pular correcao / Cancelar).
 */
export async function correctStreaming(
  conn: Connection,
  text: string,
  opts: { signal?: AbortSignal; timeoutMs: number; pane?: number; test?: boolean; onDelta?: (soFar: string) => void },
): Promise<CorrectResult> {
  const ac = new AbortController();
  let timedOut = false;
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, opts.timeoutMs + UI_GRACE_MS);
  let soFar = "";
  try {
    const resp = await conn.postStream("/api/voice/correct", { text, pane_id: opts.pane, test: opts.test }, ac.signal);
    const reader = resp.body?.getReader();
    if (!reader) throw new VoiceError("resposta sem corpo");
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      const { events, rest } = parseNDJSON(done ? buf + "\n" : buf);
      buf = rest;
      for (const ev of events) {
        if (typeof ev.delta === "string") {
          soFar += ev.delta;
          opts.onDelta?.(soFar);
        } else if (ev.done) {
          return ev as unknown as CorrectResult;
        } else if (typeof ev.error === "string") {
          throw new VoiceError(ev.error, { timeout: ev.timeout === true, kind: typeof ev.kind === "string" ? (ev.kind as VoiceErrorKind) : undefined });
        }
      }
      if (done) break;
    }
    throw new VoiceError("a correção terminou sem resposta");
  } catch (e) {
    if (e instanceof VoiceError) throw e;
    if (isAbort(e) || timedOut) {
      if (timedOut) throw new VoiceError(`a correção passou do prazo de ${Math.round(opts.timeoutMs / 1000)} s`, { timeout: true });
      throw new VoiceError("correção cancelada", { canceled: true });
    }
    throw e;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

// --- apresentacao ---------------------------------------------------------

/** US$ com casas suficientes para centavos de centavo. */
export function formatUSD(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "US$ 0";
  const digits = v >= 1 ? 2 : v >= 0.01 ? 4 : v >= 0.0001 ? 5 : 6;
  return `US$ ${v.toFixed(digits).replace(".", ",")}`;
}

export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}

/** Texto final com as quebras e o fim marcados (onde NAO ha' Enter). */
export function markNoEnter(msg: string): string {
  return `${msg.replace(/\n/g, " ⏎(quebra, sem Enter)\n")} ⟂(fim — sem Enter)`;
}

export interface PipelineStep {
  title: string;
  status: "ok" | "erro" | "pulado" | "rodando" | "pendente";
  ms?: number;
  lines: string[];
}

export interface CompareRow {
  route: "openai" | "native";
  format: "webm" | "wav";
  round: number;
  ttfb_ms?: number;
  ms?: number;
  error?: string;
}

/** Caminhos do "Comparar caminhos": rota nativa so' na DeepInfra; 2 rodadas. */
export function comparePlan(provider: string, rounds = 2): CompareRow[] {
  const routes: CompareRow["route"][] = provider === "deepinfra" ? ["openai", "native"] : ["openai"];
  const out: CompareRow[] = [];
  for (let round = 1; round <= rounds; round++)
    for (const route of routes) for (const format of ["webm", "wav"] as const) out.push({ route, format, round });
  return out;
}

/** Melhor caminho pela media do total (so' os que deram certo). */
export function fastestPath(rows: CompareRow[]): { route: string; format: string; avgMs: number } | null {
  const acc = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    if (r.ms === undefined || r.error) continue;
    const k = `${r.route}|${r.format}`;
    const a = acc.get(k) ?? { sum: 0, n: 0 };
    a.sum += r.ms;
    a.n++;
    acc.set(k, a);
  }
  let best: { route: string; format: string; avgMs: number } | null = null;
  for (const [k, a] of acc) {
    const [route, format] = k.split("|");
    const avg = a.sum / a.n;
    if (!best || avg < best.avgMs) best = { route, format, avgMs: avg };
  }
  return best;
}

/** Relatorio do "Testar tudo" em texto (botao Copiar). */
export function reportText(steps: PipelineStep[], when: Date): string {
  const mark = { ok: "✓", erro: "✗", pulado: "–", rodando: "…", pendente: "·" } as const;
  const out = [`BethTerm — teste de voz (${when.toLocaleString("pt-BR")})`, ""];
  steps.forEach((s, i) => {
    out.push(`${mark[s.status]} ${i + 1}. ${s.title}${s.ms !== undefined ? ` (${formatSeconds(s.ms)})` : ""}`);
    for (const l of s.lines) out.push(`    ${l}`);
  });
  return out.join("\n");
}
