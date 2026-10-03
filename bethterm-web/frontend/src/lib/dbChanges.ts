// Alterações pendentes na grade da tabela (Aplicar / Descartar). As linhas
// são identificadas pelo próprio array (o mesmo objeto que a grade recebeu),
// então ordenar a tela não perde nada. Funções puras: tests/dbChanges.test.ts.

import type { DbCell, DbResultColumn } from "./dbApi.ts";

export interface PendingChanges {
  /** linha (original ou nova) -> coluna -> valor digitado (null = NULL) */
  edits: Map<DbCell[], Map<string, string | null>>;
  /** linhas originais marcadas para apagar */
  deleted: Set<DbCell[]>;
  /** linhas novas, na ordem em que foram criadas */
  added: DbCell[][];
}

export function emptyChanges(): PendingChanges {
  return { edits: new Map(), deleted: new Set(), added: [] };
}

function clone(ch: PendingChanges): PendingChanges {
  return { edits: new Map(ch.edits), deleted: new Set(ch.deleted), added: ch.added.slice() };
}

export function isAdded(ch: PendingChanges, row: DbCell[]): boolean {
  return ch.added.includes(row);
}

/** Quantas linhas mudam ao aplicar. */
export function changeCount(ch: PendingChanges): number {
  let n = ch.deleted.size + ch.added.length;
  for (const [row, m] of ch.edits) if (m.size && !isAdded(ch, row) && !ch.deleted.has(row)) n++;
  return n;
}

/** Valor digitado nesta célula, ou undefined se não mudou. */
export function editedValue(ch: PendingChanges, row: DbCell[], col: string): string | null | undefined {
  const m = ch.edits.get(row);
  return m && m.has(col) ? m.get(col)! : undefined;
}

export function setCell(ch: PendingChanges, row: DbCell[], col: string, value: string | null, original?: DbCell): PendingChanges {
  const out = clone(ch);
  const m = new Map(out.edits.get(row) ?? []);
  // voltou ao valor de antes (linha original): não é mais alteração
  const same = !isAdded(ch, row) && original !== undefined && (value === null ? original === null : original !== null && String(original) === value);
  if (same) m.delete(col);
  else m.set(col, value);
  if (m.size) out.edits.set(row, m);
  else out.edits.delete(row);
  return out;
}

/** Apaga (ou desfaz o apagar). Linha nova some de vez. */
export function toggleDelete(ch: PendingChanges, row: DbCell[]): PendingChanges {
  const out = clone(ch);
  if (isAdded(ch, row)) {
    out.added = out.added.filter((r) => r !== row);
    out.edits.delete(row);
  } else if (out.deleted.has(row)) out.deleted.delete(row);
  else out.deleted.add(row);
  return out;
}

/** Linha nova vazia (as colunas não preenchidas usam o padrão do banco). */
export function addRow(ch: PendingChanges, width: number): { changes: PendingChanges; row: DbCell[] } {
  const row: DbCell[] = new Array(width).fill(null);
  const out = clone(ch);
  out.added.push(row);
  return { changes: out, row };
}

/** Linha nova com os valores de outra, menos a chave e o que não dá para copiar. */
export function duplicateRow(
  ch: PendingChanges,
  source: DbCell[],
  columns: DbResultColumn[],
  skip: Set<string>,
): { changes: PendingChanges; row: DbCell[] } {
  const { changes, row } = addRow(ch, columns.length);
  const m = new Map<string, string | null>();
  columns.forEach((c, i) => {
    if (skip.has(c.name)) return;
    const typed = editedValue(ch, source, c.name);
    const v = typed !== undefined ? typed : source[i];
    m.set(c.name, v === null || v === undefined ? null : String(v));
  });
  if (m.size) changes.edits.set(row, m);
  return { changes, row };
}

/** Desfaz o que foi feito nesta linha (edições e apagar). */
export function revertRow(ch: PendingChanges, row: DbCell[]): PendingChanges {
  if (isAdded(ch, row)) return toggleDelete(ch, row);
  const out = clone(ch);
  out.edits.delete(row);
  out.deleted.delete(row);
  return out;
}

export interface ApplyBody {
  deletes: { where: Record<string, DbCell> }[];
  updates: { where: Record<string, DbCell>; set: Record<string, string | null> }[];
  inserts: { values: Record<string, string | null> }[];
}

/** O que vai para POST /api/db/apply. O WHERE usa os valores ORIGINAIS da chave. */
export function buildApply(ch: PendingChanges, rows: DbCell[][], columns: DbResultColumn[], pk: string[]): ApplyBody {
  const idx = new Map(columns.map((c, i) => [c.name, i]));
  const whereOf = (row: DbCell[]) => {
    const w: Record<string, DbCell> = {};
    for (const p of pk) {
      const i = idx.get(p);
      if (i === undefined) throw new Error(`a chave primária (${p}) não está no resultado`);
      w[p] = row[i] ?? null;
    }
    return w;
  };
  const body: ApplyBody = { deletes: [], updates: [], inserts: [] };
  for (const row of rows) {
    if (ch.deleted.has(row)) body.deletes.push({ where: whereOf(row) });
    else {
      const m = ch.edits.get(row);
      if (m?.size) body.updates.push({ where: whereOf(row), set: Object.fromEntries(m) });
    }
  }
  for (const row of ch.added) body.inserts.push({ values: Object.fromEntries(ch.edits.get(row) ?? []) });
  return body;
}

/** WHERE (valores da chave) de cada linha, para apagar já. Falha se a chave não está no resultado. */
export function buildDeletes(rows: DbCell[][], columns: DbResultColumn[], pk: string[]): ApplyBody["deletes"] {
  if (pk.length === 0) throw new Error("sem chave primária");
  const idx = new Map(columns.map((c, i) => [c.name, i]));
  return rows.map((row) => {
    const where: Record<string, DbCell> = {};
    for (const p of pk) {
      const i = idx.get(p);
      if (i === undefined) throw new Error(`a chave primária (${p}) não está no resultado`);
      const v = row[i] ?? null;
      if (v === null) throw new Error(`a chave primária (${p}) está vazia numa das linhas`);
      where[p] = v;
    }
    return { where };
  });
}

/**
 * Por que não dá para apagar (texto para o tooltip), ou "" se dá.
 * `pk` vazio = o banco não informou chave única; coluna fora do resultado = o SELECT não traz o id.
 */
export function deleteBlocker(pk: string[] | undefined, columns: DbResultColumn[] | null | undefined): string {
  if (!pk || pk.length === 0) return "Só dá para apagar quando o resultado vem de uma tabela com chave primária (SELECT simples de uma tabela).";
  const have = new Set((columns ?? []).map((c) => c.name));
  const missing = pk.filter((p) => !have.has(p));
  if (missing.length) return `Inclua a coluna da chave (${missing.join(", ")}) no SELECT para saber qual linha apagar.`;
  return "";
}
