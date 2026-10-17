// Guarda o áudio gravado até a transcrição dar certo. Fica na memória (vale
// para a conversa aberta) e no IndexedDB (sobrevive se o navegador recarregar
// a página ou o iPhone descartar o app em segundo plano). Todo acesso ao
// navegador é opcional: sem IndexedDB o áudio continua na memória.

export interface SavedTake {
  paneId: number;
  blob: Blob;
  seconds: number;
  savedAt: number;
}

const DB = "bethphone";
const STORE = "takes";
const mem = new Map<number, SavedTake>();

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "paneId" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  try {
    return await new Promise<T | undefined>((resolve) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    });
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/** Guarda (ou troca) o áudio pendente deste terminal. */
export async function saveTake(t: SavedTake): Promise<void> {
  mem.set(t.paneId, t);
  await run("readwrite", (s) => s.put(t));
}

/** O áudio pendente deste terminal, se houver. */
export async function loadTake(paneId: number): Promise<SavedTake | null> {
  const m = mem.get(paneId);
  if (m) return m;
  const r = (await run("readonly", (s) => s.get(paneId))) as SavedTake | undefined;
  if (r?.blob && r.blob.size > 0) {
    mem.set(paneId, r);
    return r;
  }
  return null;
}

/** Apaga o áudio pendente: só depois de transcrito ou descartado de propósito. */
export async function clearTake(paneId: number): Promise<void> {
  mem.delete(paneId);
  await run("readwrite", (s) => s.delete(paneId));
}
