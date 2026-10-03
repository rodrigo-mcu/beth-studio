// Notas do editor "Sem título": ficam em arquivos .md com timestamp na pasta de
// dados (Go: notes.go). O painel salva sozinho; aqui só o cliente da API e o
// texto da data. Testado em tests/notes.test.ts.
import type { Connection } from "./connection";

export interface NoteInfo {
  id: string;
  title: string;
  at: string;
  size: number;
}

export const notesApi = {
  list: (c: Connection) => c.api<{ notes: NoteInfo[] }>("/api/notes", {}),
  read: (c: Connection, id: string) => c.api<{ id: string; text: string }>("/api/notes/read", { id }),
  save: (c: Connection, id: string | null, text: string) => c.api<{ id: string; notes: NoteInfo[] }>("/api/notes/save", { id: id ?? "", text }),
  remove: (c: Connection, id: string) => c.api<{ notes: NoteInfo[] }>("/api/notes/delete", { id }),
};

const p2 = (n: number) => String(n).padStart(2, "0");

/** "02/10 15:04" (com o ano quando não é o ano de agora). */
export function noteWhen(at: string, now: Date = new Date()): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const base = `${p2(d.getDate())}/${p2(d.getMonth() + 1)}`;
  const year = d.getFullYear() === now.getFullYear() ? "" : `/${d.getFullYear()}`;
  return `${base}${year} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
