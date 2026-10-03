// Banco de dados: funções puras de formatação e exportação (testadas em
// tests/dbFormat.test.ts). Nada aqui fala com a rede.

import type { DbCell, DbFilterOp, DbResultColumn, DbStmtKind } from "./dbApi";

/** Texto de uma célula para copiar/exportar (NULL vira vazio). */
export function cellRaw(v: DbCell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** Texto curto, numa linha só, para a grade. */
export function cellDisplay(v: DbCell, max = 200): string {
  if (v === null || v === undefined) return "NULL";
  let s = cellRaw(v).replace(/\r\n|\r|\n/g, " ↵ ").replace(/\t/g, " ");
  if (s.length > max) s = s.slice(0, max) + "…";
  return s;
}

const NUMERIC_RE =
  /^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|INT2|INT4|INT8|SERIAL|BIGSERIAL|DECIMAL|NUMERIC|FLOAT|FLOAT4|FLOAT8|DOUBLE|REAL|MONEY|SMALLMONEY|UNSIGNED \w+)(\b|\(|$)/i;

/** Colunas numéricas ficam alinhadas à direita. */
export function isNumericType(t: string | undefined): boolean {
  if (!t) return false;
  return NUMERIC_RE.test(t.trim());
}

/** Célula de CSV (RFC 4180): aspas quando há separador, aspas ou quebra de linha. */
export function csvCell(s: string, sep: string): string {
  if (s.includes(sep) || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** CSV com cabeçalho. `sep` ";" abre direto no Excel em português. */
export function toCSV(columns: DbResultColumn[], rows: DbCell[][], sep = ",", bom = true): string {
  const lines = [columns.map((c) => csvCell(c.name, sep)).join(sep)];
  for (const r of rows) lines.push(r.map((v) => csvCell(cellRaw(v), sep)).join(sep));
  return (bom ? "﻿" : "") + lines.join("\r\n") + "\r\n";
}

/** Nomes de coluna únicos (duas colunas "id" viram "id" e "id_2"). */
export function uniqueNames(columns: DbResultColumn[]): string[] {
  const seen = new Map<string, number>();
  return columns.map((c) => {
    const base = c.name || "coluna";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });
}

/** JSON: lista de objetos, uma chave por coluna. */
export function toJSON(columns: DbResultColumn[], rows: DbCell[][]): string {
  const names = uniqueNames(columns);
  const objs = rows.map((r) => {
    const o: Record<string, DbCell> = {};
    names.forEach((n, i) => (o[n] = r[i] ?? null));
    return o;
  });
  return JSON.stringify(objs, null, 2) + "\n";
}

/** Linha separada por tabulação (cola certinho numa planilha). */
export function rowTSV(row: DbCell[]): string {
  return row.map((v) => cellRaw(v).replace(/\t/g, " ").replace(/\r?\n/g, " ")).join("\t");
}

/** Várias linhas com cabeçalho, separadas por tabulação. */
export function rowsTSV(columns: DbResultColumn[], rows: DbCell[][]): string {
  return [columns.map((c) => c.name).join("\t"), ...rows.map(rowTSV)].join("\r\n");
}

/** Nome de arquivo seguro: "consulta_2026-09-25_14-03.csv". */
export function exportFileName(base: string, ext: string, now = new Date()): string {
  const clean =
    base
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "resultado";
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}-${p(now.getMinutes())}`;
  return `${clean}_${stamp}.${ext}`;
}

/** "850 ms", "1,2 s", "2 min 5 s". */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m} min ${s} s`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("pt-BR");
}

/** "1 linha", "2.500 linhas". */
export function plural(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

export const FILTER_OPS: { op: DbFilterOp; label: string; needsValue: boolean }[] = [
  { op: "contains", label: "contém", needsValue: true },
  { op: "eq", label: "=", needsValue: true },
  { op: "ne", label: "≠", needsValue: true },
  { op: "gt", label: ">", needsValue: true },
  { op: "ge", label: "≥", needsValue: true },
  { op: "lt", label: "<", needsValue: true },
  { op: "le", label: "≤", needsValue: true },
  { op: "starts", label: "começa com", needsValue: true },
  { op: "ends", label: "termina com", needsValue: true },
  { op: "null", label: "é NULL", needsValue: false },
  { op: "notnull", label: "não é NULL", needsValue: false },
];

export function kindLabel(k: DbStmtKind): string {
  switch (k) {
    case "read":
      return "leitura";
    case "write":
      return "altera dados";
    case "ddl":
      return "altera a estrutura";
    case "tx":
      return "controle de transação";
    case "session":
      return "altera a sessão";
    default:
      return "não reconhecida";
  }
}

/** Id de consulta aleatório (para cancelar). */
export function newQueryId(): string {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return "q" + Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Resumo de um resultado: "2.500 linhas · 12 ms" ou "3 linhas afetadas". */
export function resultSummary(r: {
  has_rows: boolean;
  rows: unknown[];
  affected?: number;
  has_more: boolean;
  truncated?: string;
  elapsed_ms: number;
}): string {
  const parts: string[] = [];
  if (r.has_rows) {
    parts.push(plural(r.rows.length, "linha", "linhas") + (r.has_more ? "+" : ""));
    if (r.truncated === "bytes") parts.push("resposta limitada pelo tamanho");
    else if (r.truncated === "limit") parts.push("limite total de linhas atingido");
    else if (r.truncated === "rows" && !r.has_more) parts.push("limitado; o resto foi descartado");
  } else if (typeof r.affected === "number") {
    parts.push(plural(r.affected, "linha afetada", "linhas afetadas"));
  } else {
    parts.push("comando executado");
  }
  parts.push(formatMs(r.elapsed_ms));
  return parts.join(" · ");
}

/** Cores de etiqueta das conexões. */
export const CONN_COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#46a758", "#12a594", "#0090ff", "#8e4ec6", "#d6409f", "#8d8d8d"];

/** Nome entre aspas do jeito do banco: "x" (PostgreSQL/SQLite), `x` (MySQL), [x] (SQL Server). */
export function quoteIdent(d: string, name: string): string {
  if (d === "mysql") return "`" + name.replace(/`/g, "``") + "`";
  if (d === "sqlserver") return "[" + name.replace(/]/g, "]]") + "]";
  return '"' + name.replace(/"/g, '""') + '"';
}

export function driverLabel(d: string): string {
  switch (d) {
    case "postgres":
      return "PostgreSQL";
    case "mysql":
      return "MySQL / MariaDB";
    case "sqlserver":
      return "SQL Server";
    case "sqlite":
      return "SQLite";
    default:
      return d;
  }
}

export function sslLabel(m: string): string {
  switch (m) {
    case "disable":
      return "Desligado";
    case "prefer":
      return "Se disponível";
    case "require":
      return "Obrigatório (sem verificar certificado)";
    case "verify-ca":
      return "Obrigatório + verificar CA";
    case "verify-full":
      return "Obrigatório + verificar certificado e nome";
    default:
      return m;
  }
}
