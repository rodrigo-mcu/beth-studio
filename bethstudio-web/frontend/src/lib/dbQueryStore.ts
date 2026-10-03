// Histórico e consultas salvas do editor (no navegador, não no banco).

export interface DbQueryEntry {
  id: string;
  connId: string;
  sql: string;
  at: string;
  name?: string;
}

export interface DbQueryStore {
  history: DbQueryEntry[];
  saved: DbQueryEntry[];
}

/** connId de uma consulta salva que vale para todas as conexões. */
export const ALL_CONNECTIONS = "";

export const DB_QUERY_HISTORY_MAX = 40;
const STORAGE_KEY = "bethstudio.db.queries";

export function emptyQueryStore(): DbQueryStore {
  return { history: [], saved: [] };
}

function nid(): string {
  return `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Guarda a consulta no histórico desta conexão. Repetir o mesmo texto sobe a entrada. */
export function pushHistory(store: DbQueryStore, connId: string, sql: string, at = new Date().toISOString()): DbQueryStore {
  const text = sql.trim();
  if (!connId || !text) return store;
  const history = [{ id: nid(), connId, sql: text, at }, ...store.history.filter((h) => !(h.connId === connId && h.sql === text))].slice(0, DB_QUERY_HISTORY_MAX);
  return { ...store, history };
}

/** Salva com nome. connId = ALL_CONNECTIONS ("") grava uma consulta para usar em qualquer conexão e banco. */
export function saveQuery(store: DbQueryStore, connId: string, name: string, sql: string, at = new Date().toISOString()): DbQueryStore {
  const text = sql.trim();
  const title = name.trim();
  if (!text || !title) return store;
  const saved = store.saved.filter((s) => !(s.connId === connId && s.name === title));
  return { ...store, saved: [{ id: nid(), connId, sql: text, name: title, at }, ...saved].slice(0, 4000) };
}

/** Salvas que aparecem numa conexão: as de todas as conexões e as só dela, por nome. */
export function savedFor(store: DbQueryStore, connId: string): DbQueryEntry[] {
  return store.saved
    .filter((s) => s.name && (s.connId === ALL_CONNECTIONS || s.connId === connId))
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "pt-BR", { sensitivity: "base" }));
}

export function deleteSaved(store: DbQueryStore, id: string): DbQueryStore {
  return { ...store, saved: store.saved.filter((s) => s.id !== id) };
}

export function loadQueryStore(): DbQueryStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyQueryStore();
    const p = JSON.parse(raw) as Partial<DbQueryStore>;
    const ok = (x: unknown): x is DbQueryEntry =>
      !!x && typeof x === "object" && typeof (x as DbQueryEntry).id === "string" && typeof (x as DbQueryEntry).sql === "string" && typeof (x as DbQueryEntry).connId === "string";
    return {
      history: Array.isArray(p.history) ? p.history.filter(ok).slice(0, DB_QUERY_HISTORY_MAX) : [],
      saved: Array.isArray(p.saved) ? p.saved.filter(ok).slice(0, 4000) : [],
    };
  } catch {
    return emptyQueryStore();
  }
}

export function writeQueryStore(store: DbQueryStore) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* cota do navegador */
  }
}
