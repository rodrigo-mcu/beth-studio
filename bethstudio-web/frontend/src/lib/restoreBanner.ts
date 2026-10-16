// Faixa de progresso da restauracao dos terminais depois de uma queda do host
// (restore.go). Testado em tests/restoreBanner.test.ts.

import type { Connection } from "./connection";

export interface RestoreFailure {
  pane_id: number;
  title?: string;
  reason: string;
}

/** Terminal WSL que nao abriu porque a pasta dele nao existe (o WSL ainda nao montou o disco). */
export interface RestorePendingItem {
  pane_id: number;
  title?: string;
  distro: string;
  cwd: string;
  /** "Guardar": o Studio para de tentar sozinho */
  keep?: boolean;
}

export interface RestoreEvent {
  ev: "restore";
  stage: "start" | "wsl" | "ask_init" | "init" | "spawn" | "done" | "finished";
  total: number;
  done: number;
  distro?: string;
  message?: string;
  /** estagio ask_init: as pastas que faltam */
  missing?: string[];
  failed?: RestoreFailure[];
  pending?: RestorePendingItem[];
  warnings?: string[];
}

export interface RestoreBannerInfo {
  text: string;
  /** progresso em andamento (mostra o giro) */
  busy: boolean;
  /** detalhes (falhas, avisos) para o resumo final */
  details: string[];
  /** pergunta aberta: "executar o init do WSL?" (so' presente enquanto ha pergunta) */
  ask?: { distro: string; missing: string[] };
  /** init em andamento: "continuar assim mesmo" */
  init?: { distro: string };
  /** terminais aguardando a pasta (so' presente quando ha algum) */
  pending?: RestorePendingItem[];
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** O que mostrar (null = nada). `now` e `finishedAt` deixam o resumo sumir sozinho. */
export function restoreBanner(r: RestoreEvent | null, now = Date.now(), finishedAt = 0): RestoreBannerInfo | null {
  if (!r) return null;
  if (r.stage === "ask_init") {
    const distro = r.distro ?? "";
    const missing = r.missing ?? [];
    const what =
      missing.length === 0
        ? `Há pastas que não existem no WSL ${distro}.`
        : missing.length === 1
          ? `A pasta ${missing[0]} não existe no WSL ${distro}.`
          : `A pasta ${missing[0]} (e mais ${missing.length - 1}) não existe no WSL ${distro}.`;
    return { text: `${what} Executar o script de inicialização?`, busy: false, details: [], ask: { distro, missing } };
  }
  if (r.stage === "init") {
    const distro = r.distro ?? "";
    return { text: r.message || `Executando o init do WSL (${distro})…`, busy: true, details: [], init: { distro } };
  }
  if (r.stage !== "finished") {
    if (r.stage === "wsl" && r.distro) return { text: r.message || `Aguardando o WSL (${r.distro})…`, busy: true, details: [] };
    if (r.total > 0) return { text: `Restaurando terminais (${Math.min(r.done, r.total)} de ${r.total})…`, busy: true, details: [] };
    return { text: "Restaurando terminais…", busy: true, details: [] };
  }
  const failed = r.failed ?? [];
  const pending = r.pending ?? [];
  const warnings = r.warnings ?? [];
  if (failed.length === 0 && pending.length === 0 && warnings.length === 0) {
    // tudo certo: um aviso curto que some em 8 s
    if (finishedAt && now - finishedAt > 8000) return null;
    return { text: `${r.done} ${r.done === 1 ? "terminal restaurado" : "terminais restaurados"}.`, busy: false, details: [] };
  }
  const parts = [`${r.done} de ${r.total} restaurados`];
  if (failed.length) parts.push(`${failed.length} não ${plural(failed.length, "voltou", "voltaram")}`);
  if (pending.length) parts.push(`${pending.length} aguardando a pasta`);
  const details = [...failed.map((f) => `${f.title || `Terminal ${f.pane_id}`}: ${f.reason}`), ...warnings];
  const out: RestoreBannerInfo = { text: parts.join(", ") + ".", busy: false, details };
  if (pending.length) out.pending = pending;
  return out;
}

export type InitAnswer = "run" | "skip" | "continue";
export type PendingAction = "retry" | "default" | "keep" | "discard";

/** Responde a pergunta do init ("run" / "skip") ou manda seguir sem esperar o init ("continue"). */
export async function answerRestoreInit(conn: Connection, distro: string, action: InitAnswer): Promise<void> {
  await conn.api("/api/restore/answer", { distro, action });
}

/** Acao do usuario sobre um terminal que aguarda a pasta; `opened` diz se ele abriu agora. */
export async function actOnPending(conn: Connection, paneId: number, action: PendingAction): Promise<{ opened: boolean }> {
  const r = await conn.api<{ ok: boolean; opened?: boolean }>("/api/restore/pending", { pane_id: paneId, action });
  return { opened: !!r.opened };
}
