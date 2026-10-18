// Fila persistente de áudios gravados. Funções puras (sem disco, sem rede):
// o estado de cada gravação até o texto chegar. Quem salva e quem envia é
// service.ts; aqui só se decide o que acontece em cada passo.
//
// Uma gravação é uma lista de trechos (arquivos .m4a fechados, um a cada
// poucos minutos): se o app morrer no meio, os trechos já fechados sobrevivem.

import { isRetryable, MAX_ATTEMPTS, retryDelayMs } from "./retry";

export interface Part {
  /** arquivo no disco do aparelho (file://…) */
  uri: string;
  seconds: number;
  /** texto deste trecho; null = ainda não transcrito ("" = sem fala) */
  text: string | null;
}

export type TakeStatus =
  | "recording" // gravando agora (ou o app morreu gravando)
  | "pending" // esperando a hora de enviar (nextAttemptAt)
  | "sending" // enviando agora
  | "failed" // desistiu: Tentar de novo / Baixar / Descartar
  | "ready"; // texto pronto, esperando ir para o campo

export interface Take {
  id: string;
  createdAt: number;
  seconds: number;
  parts: Part[];
  status: TakeStatus;
  /** falhas seguidas no trecho atual */
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  text: string | null;
}

const STATUSES: readonly TakeStatus[] = ["recording", "pending", "sending", "failed", "ready"];

export function newTake(id: string, now: number): Take {
  return { id, createdAt: now, seconds: 0, parts: [], status: "recording", attempts: 0, nextAttemptAt: now, lastError: null, text: null };
}

export function addPart(t: Take, p: Part): Take {
  return { ...t, parts: [...t.parts, p] };
}

export function finishRecording(t: Take, seconds: number, now: number): Take {
  return { ...t, seconds, status: "pending", attempts: 0, nextAttemptAt: now, lastError: null };
}

export function startSending(t: Take): Take {
  return { ...t, status: "sending" };
}

/** Um trecho foi transcrito: guarda o texto e zera as falhas. */
export function partDone(t: Take, index: number, text: string): Take {
  const parts = t.parts.map((p, i) => (i === index ? { ...p, text: text.trim() } : p));
  return { ...t, parts, attempts: 0, lastError: null };
}

export function allPartsDone(t: Take): boolean {
  return t.parts.length > 0 && t.parts.every((p) => p.text !== null);
}

export function joinTexts(parts: Part[]): string {
  return parts
    .map((p) => (p.text ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

/** Todos os trechos transcritos: texto pronto, ou "sem fala" (o áudio fica guardado). */
export function completeTake(t: Take): Take {
  const text = joinTexts(t.parts);
  if (!text) return { ...t, status: "failed", text: null, lastError: "Não reconheci fala nesse áudio. Tente de novo ou descarte." };
  return { ...t, status: "ready", text, lastError: null };
}

/** Falha de envio: agenda a próxima tentativa (2, 4, 8, 15, 30 s) ou desiste na sexta. */
export function sendFailed(t: Take, error: unknown, now: number): Take {
  const attempts = t.attempts + 1;
  const message = error instanceof Error ? error.message : String(error);
  if (!isRetryable(error) || attempts >= MAX_ATTEMPTS) {
    return { ...t, status: "failed", attempts, lastError: message };
  }
  return { ...t, status: "pending", attempts, nextAttemptAt: now + retryDelayMs(attempts - 1), lastError: message };
}

/** Botão Tentar de novo. */
export function manualRetry(t: Take, now: number): Take {
  return { ...t, status: "pending", attempts: 0, nextAttemptAt: now, lastError: null };
}

/** O que já pode ser enviado, o mais antigo primeiro. */
export function dueTakes(takes: Take[], now: number): Take[] {
  return takes.filter((t) => t.status === "pending" && t.nextAttemptAt <= now).sort((a, b) => a.createdAt - b.createdAt);
}

/** Quando acordar para a próxima tentativa (null = nada agendado). */
export function nextWakeAt(takes: Take[]): number | null {
  let min: number | null = null;
  for (const t of takes) {
    if (t.status !== "pending") continue;
    if (min === null || t.nextAttemptAt < min) min = t.nextAttemptAt;
  }
  return min;
}

/** Ao abrir o app: o que estava gravando ou enviando quando ele morreu volta para a fila. */
export function recoverInterrupted(takes: Take[], now: number): Take[] {
  const out: Take[] = [];
  for (const t of takes) {
    if (t.status === "recording" || t.status === "sending") {
      if (t.parts.length === 0) continue;
      const seconds = t.seconds || t.parts.reduce((n, p) => n + p.seconds, 0);
      out.push({ ...t, seconds, status: "pending", nextAttemptAt: now });
    } else {
      out.push(t);
    }
  }
  return out;
}

function isPart(v: unknown): v is Part {
  const p = v as Part;
  return typeof p === "object" && p !== null && typeof p.uri === "string" && typeof p.seconds === "number" && (p.text === null || typeof p.text === "string");
}

function isTake(v: unknown): v is Take {
  const t = v as Take;
  return (
    typeof t === "object" &&
    t !== null &&
    typeof t.id === "string" &&
    typeof t.createdAt === "number" &&
    typeof t.seconds === "number" &&
    typeof t.attempts === "number" &&
    typeof t.nextAttemptAt === "number" &&
    STATUSES.includes(t.status) &&
    Array.isArray(t.parts) &&
    t.parts.every(isPart) &&
    (t.lastError === null || typeof t.lastError === "string") &&
    (t.text === null || typeof t.text === "string")
  );
}

/** Lê a fila salva; lixo ou item quebrado é ignorado, nunca estoura. */
export function parseQueue(raw: string | null): Take[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter(isTake) : [];
  } catch {
    return [];
  }
}
