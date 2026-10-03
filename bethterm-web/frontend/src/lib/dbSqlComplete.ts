// Autocomplete do editor SQL: palavras do dialeto, tabelas, views e colunas
// da conexão. Função pura; o editor só desenha a lista.

import type { DbDriver } from "./dbApi.ts";
import { SQL_KEYWORDS } from "./dbSqlHighlight.ts";

export type SqlCompleteKind = "keyword" | "fn" | "table" | "view" | "column" | "schema";

export interface SqlColumnInfo {
  name: string;
  type: string;
  pk?: boolean;
}

export interface SqlTableInfo {
  schema: string;
  name: string;
  type?: string;
  columns?: SqlColumnInfo[];
}

export interface SqlCatalog {
  defaultSchema: string;
  schemas: string[];
  tables: SqlTableInfo[];
}

export interface SqlCompleteItem {
  label: string;
  insert: string;
  kind: SqlCompleteKind;
  detail?: string;
}

export interface SqlComplete {
  start: number;
  items: SqlCompleteItem[];
  /** Tabelas citadas que ainda não têm colunas no catálogo. */
  missing: { schema: string; table: string }[];
  /** Abrir mesmo com prefixo vazio (depois de FROM, JOIN ou um ponto). */
  wide: boolean;
}

const FUNCS = ["COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE", "NULLIF", "CAST", "CONVERT", "LOWER", "UPPER", "LENGTH", "SUBSTRING", "TRIM", "REPLACE", "ROUND", "ABS", "NOW", "CURRENT_DATE", "CURRENT_TIMESTAMP"];

const TABLE_POS = new Set(["FROM", "JOIN", "INTO", "UPDATE", "TABLE", "TRUNCATE"]);
const COLUMN_POS = new Set(["SELECT", "WHERE", "AND", "OR", "ON", "SET", "BY", "HAVING", "RETURNING", "WHEN", "THEN", "ELSE"]);

const empty: SqlCatalog = { defaultSchema: "", schemas: [], tables: [] };

interface Tok {
  t: string;
  s: number;
  e: number;
  kw: boolean;
}

function isIdStart(c: string) {
  return /[A-Za-z_\u00C0-\uFFFF]/.test(c);
}
function isId(c: string) {
  return /[A-Za-z0-9_$\u00C0-\uFFFF]/.test(c);
}

function quoteIdent(driver: DbDriver, name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !SQL_KEYWORDS.has(name.toUpperCase())) return name;
  if (driver === "mysql") return "`" + name.replace(/`/g, "``") + "`";
  if (driver === "sqlserver") return "[" + name.replace(/]/g, "]]") + "]";
  return '"' + name.replace(/"/g, '""') + '"';
}

/** true quando o cursor está dentro de string, comentário ou identificador citado. */
function blockedAt(sql: string, cursor: number, driver: DbDriver): boolean {
  let i = 0;
  let mode: "code" | "sq" | "dq" | "line" | "block" | "dollar" = "code";
  let dollar = "";
  while (i < cursor) {
    const c = sql[i];
    const c2 = sql.slice(i, i + 2);
    if (mode === "line") {
      if (c === "\n") mode = "code";
      i++;
      continue;
    }
    if (mode === "block") {
      if (c2 === "*/") {
        mode = "code";
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (mode === "dollar") {
      if (sql.startsWith(dollar, i)) {
        i += dollar.length;
        mode = "code";
        continue;
      }
      i++;
      continue;
    }
    if (mode === "sq" || mode === "dq") {
      const close = mode === "sq" ? "'" : '"';
      if (c === "\\" && (mode === "sq" || mode === "dq") && driver === "mysql") {
        i += 2;
        continue;
      }
      if (sql.startsWith(close + close, i)) {
        i += 2;
        continue;
      }
      if (c === close) mode = "code";
      i++;
      continue;
    }
    if (c2 === "--" || (c === "#" && driver === "mysql")) {
      mode = "line";
      i += c === "#" ? 1 : 2;
      continue;
    }
    if (c2 === "/*") {
      mode = "block";
      i += 2;
      continue;
    }
    if (c === "'") {
      mode = "sq";
      i++;
      continue;
    }
    if (c === '"' && driver === "mysql") {
      mode = "dq";
      i++;
      continue;
    }
    if (c === "$" && driver === "postgres") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m && !(i > 0 && isId(sql[i - 1]))) {
        dollar = m[0];
        mode = "dollar";
        i += dollar.length;
        continue;
      }
    }
    i++;
  }
  return mode !== "code";
}

function scan(sql: string, end: number, driver: DbDriver, openEnded: boolean): { toks: Tok[]; partial: { t: string; s: number } | null } {
  const toks: Tok[] = [];
  let partial: { t: string; s: number } | null = null;
  let i = 0;
  const pushWord = (s: number, j: number, cut: boolean) => {
    const t = sql.slice(s, j);
    if (cut) partial = { t, s };
    else toks.push({ t, s, e: j, kw: SQL_KEYWORDS.has(t.toUpperCase()) && sql[s - 1] !== "." });
  };
  while (i < end) {
    const c = sql[i];
    const c2 = sql.slice(i, i + 2);
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c2 === "--" || (c === "#" && driver === "mysql")) {
      const j = sql.indexOf("\n", i);
      i = j < 0 || j >= end ? end : j;
      continue;
    }
    if (c2 === "/*") {
      const j = sql.indexOf("*/", i + 2);
      i = j < 0 || j + 2 > end ? end : j + 2;
      continue;
    }
    if (c === "'") {
      i++;
      while (i < end) {
        if (driver === "mysql" && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql.startsWith("''", i)) {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "." && !(i + 1 < end && isIdStart(sql[i + 1]) && i > 0 && /[0-9]/.test(sql[i - 1]))) {
      toks.push({ t: ".", s: i, e: i + 1, kw: false });
      i++;
      continue;
    }
    if (isIdStart(c) || (c === "$" && driver !== "postgres")) {
      const s = i;
      i++;
      while (i < end && isId(sql[i])) i++;
      pushWord(s, i, openEnded && i === end);
      continue;
    }
    i++;
  }
  return { toks, partial };
}

function statementAt(sql: string, cursor: number): [number, number] {
  let start = 0;
  for (let i = cursor - 1; i >= 0; i--) {
    if (sql[i] === ";") {
      start = i + 1;
      break;
    }
  }
  let end = sql.length;
  for (let i = cursor; i < sql.length; i++) {
    if (sql[i] === ";") {
      end = i;
      break;
    }
  }
  return [start, end];
}

interface Ref {
  schema: string;
  table: string;
}

function aliasesOf(sql: string, from: number, to: number, driver: DbDriver, catalog: SqlCatalog): Map<string, Ref> {
  const { toks } = scan(sql.slice(from, to), to - from, driver, false);
  const map = new Map<string, Ref>();
  const remember = (schema: string, table: string, alias: string) => {
    map.set(alias.toLowerCase(), { schema, table });
    map.set(table.toLowerCase(), { schema, table });
  };
  for (let i = 0; i < toks.length; i++) {
    if (!toks[i].kw || !TABLE_POS.has(toks[i].t.toUpperCase())) continue;
    let j = i + 1;
    if (j >= toks.length || toks[j].t === ".") continue;
    let schema = catalog.defaultSchema;
    let name = toks[j].t;
    j++;
    if (j + 1 < toks.length && toks[j].t === "." && toks[j + 1].t !== ".") {
      schema = name;
      name = toks[j + 1].t;
      j += 2;
    }
    if (SQL_KEYWORDS.has(name.toUpperCase())) continue;
    let alias = name;
    if (j < toks.length && toks[j].kw && toks[j].t.toUpperCase() === "AS") j++;
    if (j < toks.length && !toks[j].kw && toks[j].t !== ".") alias = toks[j].t;
    remember(schema, name, alias);
  }
  return map;
}

function fold(s: string) {
  return s.toLowerCase();
}

function rank(prefix: string, label: string): number {
  const p = fold(prefix);
  const l = fold(label);
  if (!p) return 0;
  if (l.startsWith(p)) return 0;
  if (l.includes(p)) return 1;
  return 2;
}

function take(items: SqlCompleteItem[], prefix: string, limit = 40): SqlCompleteItem[] {
  const scored = items
    .map((it) => ({ it, r: rank(prefix, it.label) }))
    .filter((x) => x.r < 2)
    .sort((a, b) => a.r - b.r || Number(b.it.detail?.startsWith("pk")) - Number(a.it.detail?.startsWith("pk")) || a.it.label.localeCompare(b.it.label));
  const out: SqlCompleteItem[] = [];
  const seen = new Set<string>();
  for (const x of scored) {
    const k = x.it.kind + ":" + x.it.insert;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x.it);
    if (out.length >= limit) break;
  }
  return out;
}

function tableItems(catalog: SqlCatalog, driver: DbDriver, schemaFilter?: string): SqlCompleteItem[] {
  const list = catalog.tables.filter((t) => !schemaFilter || fold(t.schema) === fold(schemaFilter));
  const names = new Map<string, number>();
  for (const t of list) names.set(fold(t.name), (names.get(fold(t.name)) ?? 0) + 1);
  return list.map((t) => {
    const ambiguous = (names.get(fold(t.name)) ?? 0) > 1 && fold(t.schema) !== fold(catalog.defaultSchema);
    const qualified = schemaFilter != null || ambiguous;
    const insert = qualified && t.schema ? quoteIdent(driver, t.schema) + "." + quoteIdent(driver, t.name) : quoteIdent(driver, t.name);
    return {
      label: t.name,
      insert,
      kind: t.type === "view" ? "view" : "table",
      detail: t.schema || undefined,
    } as SqlCompleteItem;
  });
}

function columnItems(refs: Ref[], catalog: SqlCatalog, driver: DbDriver): { items: SqlCompleteItem[]; missing: { schema: string; table: string }[] } {
  const items: SqlCompleteItem[] = [];
  const missing: { schema: string; table: string }[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const table = catalog.tables.find((t) => fold(t.name) === fold(ref.table) && (!ref.schema || !t.schema || fold(t.schema) === fold(ref.schema)));
    if (!table) continue;
    if (!table.columns) {
      const key = fold(table.schema) + "." + fold(table.name);
      if (!seen.has(key)) {
        seen.add(key);
        missing.push({ schema: table.schema, table: table.name });
      }
      continue;
    }
    for (const c of table.columns) {
      items.push({
        label: c.name,
        insert: quoteIdent(driver, c.name),
        kind: "column",
        detail: (c.pk ? "pk · " : "") + (c.type || table.name),
      });
    }
  }
  items.sort((a, b) => Number(b.detail?.startsWith("pk")) - Number(a.detail?.startsWith("pk")) || a.label.localeCompare(b.label));
  return { items, missing };
}

function keywordItems(): SqlCompleteItem[] {
  return [...SQL_KEYWORDS].map((k) => ({ label: k, insert: k, kind: "keyword" as const }));
}

function funcItems(): SqlCompleteItem[] {
  return FUNCS.map((f) => ({ label: f, insert: f + "(", kind: "fn" as const, detail: "função" }));
}

function schemaItems(catalog: SqlCatalog, driver: DbDriver): SqlCompleteItem[] {
  return catalog.schemas.map((s) => ({ label: s, insert: quoteIdent(driver, s), kind: "schema" as const }));
}

/**
 * Sugestões para o cursor. `null` quando não há o que mostrar
 * (dentro de string/comentário, ou prefixo vazio fora de FROM/JOIN/ponto).
 */
export function completeSql(sql: string, cursor: number, driver: DbDriver, catalog: SqlCatalog = empty, opts?: { force?: boolean }): SqlComplete | null {
  if (cursor < 0 || cursor > sql.length) return null;
  if (blockedAt(sql, cursor, driver)) return null;
  const [st, en] = statementAt(sql, cursor);
  const local = sql.slice(st, cursor);
  const { toks, partial } = scan(local, local.length, driver, true);
  const prefix = partial?.t ?? "";
  const start = partial ? st + partial.s : cursor;

  let qualifier = "";
  let scope = toks;
  if (toks.length >= 2 && toks[toks.length - 1].t === "." && !toks[toks.length - 2].kw) {
    qualifier = toks[toks.length - 2].t;
    scope = toks.slice(0, -2);
  } else if (toks.length >= 1 && toks[toks.length - 1].t === "." && partial) {
    qualifier = "";
  }
  let prev = "";
  for (let i = scope.length - 1; i >= 0; i--) {
    if (scope[i].kw) {
      prev = scope[i].t.toUpperCase();
      break;
    }
  }
  const alias = aliasesOf(sql, st, en, driver, catalog);
  const last = scope[scope.length - 1];
  const just = !!last?.kw && (TABLE_POS.has(last.t.toUpperCase()) || COLUMN_POS.has(last.t.toUpperCase()));
  const wide = !!qualifier || (prefix === "" && just);
  if (!opts?.force && prefix === "" && !wide) return null;

  const missing: { schema: string; table: string }[] = [];
  let items: SqlCompleteItem[] = [];

  if (qualifier) {
    const q = fold(qualifier);
    const asSchema = catalog.schemas.some((s) => fold(s) === q);
    const ref = alias.get(q) ?? (catalog.tables.some((t) => fold(t.name) === q) ? { schema: catalog.defaultSchema, table: qualifier } : null);
    if (ref && !(asSchema && TABLE_POS.has(prev))) {
      const got = columnItems([ref], catalog, driver);
      items = got.items;
      missing.push(...got.missing);
    } else if (asSchema) {
      items = tableItems(catalog, driver, qualifier);
    } else {
      missing.push({ schema: catalog.defaultSchema, table: qualifier });
    }
  } else if (TABLE_POS.has(prev)) {
    items = [...tableItems(catalog, driver), ...schemaItems(catalog, driver)];
  } else {
    const refs = [...alias.values()];
    const cols = columnItems(refs, catalog, driver);
    missing.push(...cols.missing);
    items = [...cols.items, ...tableItems(catalog, driver), ...funcItems(), ...keywordItems()];
  }
  items = take(items, prefix);
  if (items.length === 0 && missing.length === 0) return null;
  return { start, items, missing, wide: wide || !!opts?.force };
}
