// "Reiniciar este terminal" (menu da aba). O shell novo nasce ANTES de o
// antigo ser encerrado: se o host nao criar o novo, o antigo fica como
// estava. O novo ocupa a mesma folha (mesmo lugar e tamanho). Testado em
// tests/restartPane.test.ts (sem React, sem rede).

import { spawnCwd } from "./agents.ts";
import { findPane, replacePane, type Layout } from "./layout.ts";
import type { PaneInfo, SpawnedEvent } from "./types";

export const RESTART_TIMEOUT_MS = 8000;

export interface RestartDeps {
  spawn: (opts: { shell_id: string; window_id?: number; cwd?: string }) => Promise<SpawnedEvent>;
  untilListed: (paneId: number) => Promise<void>;
  /** organizacao ATUAL (pode ter mudado durante a espera) */
  getLayout: () => Layout | null;
  commit: (l: Layout, delay: number) => void;
  /** encerra o antigo (killConfirmed, vindo do KillDialog ja' confirmado) */
  end: (pane: number) => void;
  timeoutMs?: number;
}

/** Devolve o pane novo. Lanca (sem encerrar nada) se o shell novo nao abrir. */
export async function restartPane(deps: RestartDeps, old: Pick<PaneInfo, "pane_id" | "window_id" | "cwd">, shellId: string): Promise<number> {
  const ms = deps.timeoutMs ?? RESTART_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`o Beth Studio não respondeu em ${Math.round(ms / 1000)} s`)), ms);
  });
  let ev: SpawnedEvent;
  try {
    ev = await Promise.race([deps.spawn({ shell_id: shellId, window_id: old.window_id, cwd: spawnCwd(old.cwd, shellId) || undefined }), timeout]);
  } finally {
    clearTimeout(timer);
  }
  await deps.untilListed(ev.pane_id);
  const cur = deps.getLayout();
  if (cur && findPane(cur, old.pane_id)) deps.commit(replacePane(cur, old.pane_id, ev.pane_id), 0);
  deps.end(old.pane_id);
  return ev.pane_id;
}
