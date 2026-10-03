// Faixa de progresso da restauracao dos terminais depois de uma queda do host
// (restore.go). Testado em tests/restoreBanner.test.ts.

export interface RestoreFailure {
  pane_id: number;
  title?: string;
  reason: string;
}

export interface RestoreEvent {
  ev: "restore";
  stage: "start" | "wsl" | "spawn" | "done" | "finished";
  total: number;
  done: number;
  distro?: string;
  message?: string;
  failed?: RestoreFailure[];
  fallbacks?: { pane_id: number; cwd: string }[];
  warnings?: string[];
}

export interface RestoreBannerInfo {
  text: string;
  /** progresso em andamento (mostra o giro) */
  busy: boolean;
  /** detalhes (falhas, pastas que abriram na home, avisos) para o resumo final */
  details: string[];
}

/** O que mostrar (null = nada). `now` e `finishedAt` deixam o resumo sumir sozinho. */
export function restoreBanner(r: RestoreEvent | null, now = Date.now(), finishedAt = 0): RestoreBannerInfo | null {
  if (!r) return null;
  if (r.stage !== "finished") {
    if (r.stage === "wsl" && r.distro) return { text: r.message || `Aguardando o WSL (${r.distro})…`, busy: true, details: [] };
    if (r.total > 0) return { text: `Restaurando terminais (${Math.min(r.done, r.total)} de ${r.total})…`, busy: true, details: [] };
    return { text: "Restaurando terminais…", busy: true, details: [] };
  }
  const failed = r.failed ?? [];
  const fallbacks = r.fallbacks ?? [];
  const warnings = r.warnings ?? [];
  if (failed.length === 0 && fallbacks.length === 0 && warnings.length === 0) {
    // tudo certo: um aviso curto que some em 8 s
    if (finishedAt && now - finishedAt > 8000) return null;
    return { text: `${r.done} ${r.done === 1 ? "terminal restaurado" : "terminais restaurados"}.`, busy: false, details: [] };
  }
  const parts = [`${r.done} de ${r.total} restaurados`];
  if (failed.length) parts.push(`${failed.length} não ${failed.length === 1 ? "voltou" : "voltaram"}`);
  if (fallbacks.length) parts.push(`${fallbacks.length} ${fallbacks.length === 1 ? "abriu" : "abriram"} na pasta inicial`);
  const details = [
    ...failed.map((f) => `${f.title || `Terminal ${f.pane_id}`}: ${f.reason}`),
    ...fallbacks.map((f) => `A pasta ${f.cwd} ainda não existia; o terminal abriu na pasta inicial.`),
    ...warnings,
  ];
  return { text: parts.join(", ") + ".", busy: false, details };
}
