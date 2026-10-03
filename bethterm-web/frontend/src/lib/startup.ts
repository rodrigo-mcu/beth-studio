// Abertura do Studio: em que etapa está (para a tela de abertura mostrar
// algo que se mexe, em vez de parecer travado) e a linha "abertura" do log
// com o tempo de cada fase. Testado em tests/startup.test.ts.
import type { SocketState } from "./types.ts";

// --- terminais que já receberam a primeira tela ------------------------------
const screened = new Set<number>();
const listeners = new Set<() => void>();

/** TerminalView chama na primeira tela recebida. */
export function markScreen(pane: number): void {
  if (screened.has(pane)) return;
  screened.add(pane);
  for (const f of listeners) f();
}

export function screenedPanes(): ReadonlySet<number> {
  return screened;
}

export function onScreened(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

// --- etapa -------------------------------------------------------------------
export type StageKey = "connect" | "list" | "layout" | "screens";

export interface StageInput {
  socket: SocketState;
  /** null = a lista de terminais ainda não chegou */
  paneCount: number | null;
  layoutReady: boolean;
  /** terminais visíveis na aba ativa */
  activePanes: number[];
  screened: ReadonlySet<number>;
  /** há quanto tempo está nesta etapa */
  stageMs: number;
}

export interface Stage {
  key: StageKey | "done";
  done: boolean;
  text: string;
  /** passou de SLOW_MS na mesma etapa */
  slow: boolean;
  /** o que oferecer quando demora */
  action: "retry" | "skip" | null;
}

export const SLOW_MS = 10_000;
/** as telas não seguram a abertura para sempre (um terminal mudo não trava tudo) */
export const SCREENS_MAX_MS = 15_000;

export function startupStage(i: StageInput): Stage {
  const slow = i.stageMs >= SLOW_MS;
  const mk = (key: StageKey, text: string, action: Stage["action"]): Stage => ({ key, done: false, text, slow, action: slow ? action : null });
  if (i.socket !== "open") return mk("connect", "Conectando ao BethTerm…", "retry");
  if (i.paneCount === null) return mk("list", "Lendo a lista de terminais…", "retry");
  if (!i.layoutReady) return mk("layout", `Montando a organização (${i.paneCount} terminais)…`, "retry");
  const n = i.activePanes.length;
  const k = i.activePanes.filter((p) => i.screened.has(p)).length;
  if (k < n && i.stageMs < SCREENS_MAX_MS) {
    return mk("screens", n === 1 ? "Abrindo o terminal desta aba…" : `Abrindo os terminais desta aba (${k} de ${n})…`, "skip");
  }
  return { key: "done", done: true, text: "", slow: false, action: null };
}

export interface StartupItem {
  id: number;
  label: string;
  /** ok = ja' mandou a primeira tela; wait = ainda abrindo */
  state: "ok" | "wait";
}

export const MAX_STARTUP_ITEMS = 12;

/**
 * Terminais que a tela de abertura lista. Na etapa das telas: os da aba
 * ativa, cada um com ok/aguardando. Antes disso (lista, organizacao): todos
 * os terminais do host, ainda aguardando.
 */
export function startupItems(
  stage: Stage["key"],
  all: { id: number; label: string }[],
  activePanes: number[],
  screened: ReadonlySet<number>,
): { items: StartupItem[]; more: number } {
  let items: StartupItem[];
  if (stage === "screens") {
    const names = new Map(all.map((p) => [p.id, p.label]));
    items = activePanes.map((id) => ({ id, label: names.get(id) ?? `Terminal ${id}`, state: screened.has(id) ? "ok" : "wait" }));
  } else if (stage === "layout") {
    items = all.map((p) => ({ id: p.id, label: p.label, state: "wait" as const }));
  } else {
    items = [];
  }
  // os que faltam primeiro: e' o que o usuario quer ver andando
  items.sort((a, b) => (a.state === b.state ? 0 : a.state === "wait" ? -1 : 1));
  const more = Math.max(0, items.length - MAX_STARTUP_ITEMS);
  return { items: items.slice(0, MAX_STARTUP_ITEMS), more };
}

const secs = (ms: number) => `${(ms / 1000).toFixed(2).replace(".", ",")}s`;

/** Tempos (ms desde o início da página) de quando cada etapa terminou. */
export function startupLogLine(t: Partial<Record<StageKey | "app", number>>, paneCount: number, screenedN: number, activeN: number): string {
  const parts: string[] = [];
  if (t.app !== undefined) parts.push(`interface carregada ${secs(t.app)}`);
  if (t.connect !== undefined) parts.push(`conectado ${secs(t.connect)}`);
  if (t.list !== undefined) parts.push(`lista ${secs(t.list)} (${paneCount} terminais)`);
  if (t.layout !== undefined) parts.push(`organização ${secs(t.layout)}`);
  if (t.screens !== undefined) parts.push(`telas ${secs(t.screens)} (${screenedN} de ${activeN})`);
  return `abertura (página): ${parts.join(" · ")}`;
}
