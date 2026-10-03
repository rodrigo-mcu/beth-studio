// "Novo terminal à direita/abaixo/acima/à esquerda" (menu do terminal).
//
// O terminal novo nasce no host como ABA NOVA da mesma janela do terminal
// clicado (spawn com o window_id dele) — nunca como split no host, para
// ficar sozinho na aba e o "Ajustar à janela" funcionar. So' no web ele
// entra ao lado do clicado, dividindo 50/50. Funcoes testadas em
// tests/splitSpawn.test.ts (sem React, sem rede).

import { spawnCwd } from "./agents.ts";
import { insertPlaceholder, removePlaceholder, resolvePlaceholder, type Layout, type Zone } from "./layout.ts";
import type { PaneInfo, ShellInfo, SpawnedEvent } from "./types";

export type SplitZone = Exclude<Zone, "center">;

export const SPLIT_ZONES: SplitZone[] = ["right", "bottom", "top", "left"];

export const ZONE_LABEL: Record<SplitZone, string> = {
  right: "Novo terminal à direita",
  bottom: "Novo terminal abaixo",
  top: "Novo terminal acima",
  left: "Novo terminal à esquerda",
};

export const SPLIT_SPAWN_TIMEOUT_MS = 8000;

/** Shell da GUI do mesmo tipo do terminal (null = nao sabemos). */
export function sameShellId(pane: Pick<PaneInfo, "kind" | "distro"> | undefined, shells: ShellInfo[] | null): string | null {
  if (!pane || !shells?.length) return null;
  const has = (id: string) => shells.some((s) => s.id === id);
  const first = (prefix: string) => shells.find((s) => s.id.startsWith(prefix))?.id ?? null;
  switch (pane.kind) {
    case "cmd":
    case "powershell":
    case "pwsh":
      return has(pane.kind) ? pane.kind : null;
    case "wsl": {
      const d = pane.distro ? `wsl.${pane.distro.toLowerCase()}` : "";
      if (d && has(d)) return d;
      return has("wsl.default") ? "wsl.default" : first("wsl");
    }
    case "gitbash":
      return first("gitbash");
    case "mobaxterm":
      return first("mobaxterm");
    default:
      return null;
  }
}

let seq = 0;
/** Id provisorio (negativo) do marcador "abrindo…". */
export function nextPlaceholderId(): number {
  seq = (seq + 1) % 1e9;
  return -seq;
}

export interface SplitSpawnDeps {
  spawn: (opts: { shell_id: string; window_id?: number; cwd?: string }) => Promise<SpawnedEvent>;
  /** organizacao ATUAL (pode ter mudado durante a espera) */
  getLayout: () => Layout | null;
  /** delay -1 = so' local (o marcador nunca e' gravado); 0 = grava */
  commit: (l: Layout, delay: number) => void;
  onError: (msg: string) => void;
  timeoutMs?: number;
  untilListed?: (paneId: number) => Promise<void>;
}

export type SplitTarget = Pick<PaneInfo, "pane_id" | "window_id" | "cwd">;

export interface SplitAroundDeps {
  /** cria o pane no host (shell local ou SSH/serial) */
  start: () => Promise<SpawnedEvent>;
  getLayout: () => Layout | null;
  commit: (l: Layout, delay: number) => void;
  timeoutMs?: number;
  /**
   * Espera o pane entrar na lista do host antes de gravar o split.
   * Sem isso o servidor marca a folha como encerrada (ainda não está em `live`).
   */
  untilListed?: (paneId: number) => Promise<void>;
}

/** Encaixa o pane que `start` criar ao lado de `target`. Lança se não couber ou se o host falhar. */
export async function splitAround(deps: SplitAroundDeps, target: SplitTarget, zone: SplitZone, label = ""): Promise<number> {
  const l0 = deps.getLayout();
  const tmp = nextPlaceholderId();
  const l1 = l0 ? insertPlaceholder(l0, target.pane_id, zone, tmp, label) : null;
  if (!l1) {
    throw new Error("Não dá para dividir aqui (o terminal não está numa aba do web ou a aba já está cheia).");
  }
  deps.commit(l1, -1);
  const ms = deps.timeoutMs ?? SPLIT_SPAWN_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`o BethTerm não respondeu em ${Math.round(ms / 1000)} s (se o terminal abrir depois, ele aparece em Não organizados)`)),
      ms,
    );
  });
  try {
    const ev = await Promise.race([deps.start(), timeout]);
    clearTimeout(timer);
    timer = undefined;
    if (deps.untilListed) await deps.untilListed(ev.pane_id);
    const cur = deps.getLayout();
    if (cur) deps.commit(resolvePlaceholder(cur, tmp, ev.pane_id, target.pane_id, zone), 0);
    return ev.pane_id;
  } catch (e) {
    const cur = deps.getLayout();
    if (cur) deps.commit(removePlaceholder(cur, tmp), 0);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Cria o shell e o encaixa ao lado de `target`. Devolve o pane novo (ou null). */
export async function splitSpawn(deps: SplitSpawnDeps, target: SplitTarget, zone: SplitZone, shellId: string, label = ""): Promise<number | null> {
  try {
    return await splitAround(
      {
        start: () =>
          deps.spawn({
            shell_id: shellId,
            window_id: target.window_id,
            cwd: spawnCwd(target.cwd, shellId) || undefined,
          }),
        getLayout: deps.getLayout,
        commit: deps.commit,
        timeoutMs: deps.timeoutMs,
        untilListed: deps.untilListed,
      },
      target,
      zone,
      label,
    );
  } catch (e) {
    const m = (e as Error).message;
    deps.onError(m.startsWith("Não dá para dividir") ? m : `Não foi possível abrir o terminal: ${m}`);
    return null;
  }
}
