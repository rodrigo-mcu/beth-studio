// Tela do celular no Beth Studio: texto legível da tela do terminal,
// ordem da lista e o que Enviar manda (colar + Enter).

import { waitingList, type AgentState } from "./agents.ts";
import type { PaneInfo } from "./types.ts";
import { sanitizePaste } from "./voice.ts";

const ansiRe =
  /\x1b\[[0-9;:?<=>!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()*+][0-9A-Za-z]|\x1b[@-Z\\-_=>78]/g;

/** Tira cores ANSI e espaços no fim de cada linha. O texto da ponte vem com SGR. */
export function plainScreen(sgr: string): string {
  const s = sgr.replace(ansiRe, "");
  const rows = s.replace(/\r\n/g, "\n").split("\n");
  const trimmed = rows.map((r) => r.replace(/[ \t\r]+$/g, ""));
  let n = trimmed.length;
  while (n > 0 && trimmed[n - 1] === "") n--;
  return trimmed.slice(0, n).join("\n");
}

/** Agentes aguardando primeiro (o mais antigo no topo), depois o resto pelo título. */
export function orderPhonePanes(panes: PaneInfo[], agents: AgentState, label: (p: PaneInfo) => string): PaneInfo[] {
  const seen = new Set<number>();
  const unique: PaneInfo[] = [];
  for (const p of panes) {
    if (seen.has(p.pane_id)) continue;
    seen.add(p.pane_id);
    unique.push(p);
  }
  const alive = new Set(unique.map((p) => p.pane_id));
  const rank = new Map(waitingList(agents, alive).map((a, i) => [a.pane, i]));
  return unique.sort((a, b) => {
    const aw = rank.has(a.pane_id) ? rank.get(a.pane_id)! : 1_000_000;
    const bw = rank.has(b.pane_id) ? rank.get(b.pane_id)! : 1_000_000;
    if (aw !== bw) return aw - bw;
    const byName = label(a).localeCompare(label(b), "pt");
    return byName || a.pane_id - b.pane_id;
  });
}

/** Texto que vai ao terminal. null = nada para enviar. O Enter vai à parte. */
export function phonePaste(text: string): string | null {
  const paste = sanitizePaste(text);
  return paste.trim() ? paste : null;
}

/**
 * Novo offset depois de um gesto. deltaLines > 0 vai para o histórico
 * (offset maior); deltaLines < 0 volta ao vivo.
 */
export function nextScrollOffset(current: number, deltaLines: number, scrollback: number): number {
  const max = scrollback > 0 ? scrollback : 0;
  return Math.max(0, Math.min(max, Math.round(current + deltaLines)));
}
