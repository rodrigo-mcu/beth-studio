// Política de nova tentativa do envio de áudio. Mesma do web app do celular
// (bethstudio-web/frontend/src/phone/retry.ts): 2, 4, 8, 15, 30 s, 6 tentativas.

const DELAYS_MS = [2000, 4000, 8000, 15000, 30000];

/** Número de tentativas antes de desistir (a pessoa ainda pode mandar tentar de novo). */
export const MAX_ATTEMPTS = 6;

/** Espera antes da tentativa seguinte (0 = depois da primeira falha). Para em 30 s. */
export function retryDelayMs(attempt: number): number {
  const i = Math.min(Math.max(Math.trunc(attempt), 0), DELAYS_MS.length - 1);
  return DELAYS_MS[i] ?? 30000;
}

export type ApiErrorKind = "network" | "timeout" | "rate_limit" | "auth" | "canceled" | "empty";

/** Erro de chamada ao PC. `kind` vem do Go (voice.go) ou do próprio app; `status` é o HTTP. */
export class ApiError extends Error {
  readonly kind?: ApiErrorKind;
  readonly status?: number;
  constructor(message: string, info: { kind?: ApiErrorKind; status?: number } = {}) {
    super(message);
    this.name = "ApiError";
    this.kind = info.kind;
    this.status = info.status;
  }
}

/**
 * Vale repetir o envio? Rede fora, PC reiniciando (5xx do proxy), prazo e
 * limite de uso passam sozinhos. Senha/chave inválida, cancelamento, "sem fala"
 * e recusas 4xx dariam o mesmo erro de novo.
 */
export function isRetryable(e: unknown): boolean {
  if (e instanceof TypeError) return true; // fetch sem resposta
  if (!(e instanceof ApiError)) return false;
  switch (e.kind) {
    case "network":
    case "timeout":
    case "rate_limit":
      return true;
    case "auth":
    case "canceled":
    case "empty":
      return false;
  }
  const s = e.status ?? 0;
  return s >= 500 || s === 408 || s === 429;
}
