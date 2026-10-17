// Nova tentativa do envio de áudio e sinais de conexão do celular. Funções
// puras, testadas em tests/phoneRetry.test.ts.

const DELAYS_MS = [2000, 4000, 8000, 15000, 30000];

/** Espera antes da tentativa seguinte (0 = depois da primeira falha). Para em 30 s. */
export function retryDelayMs(attempt: number): number {
  return DELAYS_MS[Math.min(Math.max(attempt, 0), DELAYS_MS.length - 1)];
}

/**
 * Vale repetir o envio? Rede fora, PC reiniciando (HTTP 5xx do proxy), prazo
 * e limite de uso passam sozinhos. Chave inválida, cancelamento e "sem fala"
 * dariam o mesmo erro de novo.
 */
export function isRetryable(e: unknown): boolean {
  const err = e as { name?: string; kind?: string; message?: string };
  if (err?.name === "AbortError") return false;
  if (e instanceof TypeError) return true; // fetch sem resposta
  switch (err?.kind) {
    case "network":
    case "timeout":
    case "rate_limit":
      return true;
    case "auth":
    case "canceled":
    case "empty":
      return false;
  }
  return /^HTTP 5\d\d\b/.test(err?.message ?? "");
}

export interface RetryOptions {
  signal?: AbortSignal;
  maxAttempts?: number;
  /** espera entre tentativas (troque nos testes) */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** chamado antes de cada espera, para a tela mostrar "tentando de novo em Ns" */
  onWait?: (info: { attempt: number; delayMs: number; error: Error }) => void;
}

function abortError(): Error {
  const e = new Error("cancelado");
  e.name = "AbortError";
  return e;
}

function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Roda `fn` e repete se o erro passa sozinho. O último erro sobe quando as tentativas acabam. */
export async function runWithRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const max = opts.maxAttempts ?? 6;
  const sleep = opts.sleep ?? realSleep;
  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw abortError();
    try {
      return await fn();
    } catch (e) {
      if (!isRetryable(e) || attempt + 1 >= max) throw e;
      const delayMs = retryDelayMs(attempt);
      opts.onWait?.({ attempt: attempt + 1, delayMs, error: e as Error });
      await sleep(delayMs, opts.signal);
    }
  }
}

/**
 * A conexão está parada? Mandamos uma sonda ao PC e esperamos qualquer
 * mensagem de volta. Sem nada depois da sonda, dentro do prazo, o socket
 * morreu sem avisar (rede trocou, tela apagou).
 */
export function socketIsStale(s: { probeAt: number; lastRx: number; now: number; graceMs: number }): boolean {
  if (!s.probeAt) return false;
  if (s.lastRx >= s.probeAt) return false;
  return s.now - s.probeAt >= s.graceMs;
}

/** Falhas seguidas da checagem de sessão antes de dizer "PC desconectado". */
export const OFFLINE_AFTER = 3;

export function offlineVerdict(consecutiveFailures: number): boolean {
  return consecutiveFailures >= OFFLINE_AFTER;
}
