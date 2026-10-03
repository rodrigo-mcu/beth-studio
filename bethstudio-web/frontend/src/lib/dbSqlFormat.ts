// Ferramentas de SQL do editor (formatar, plano, INSERT, localizar).
// Funções puras, testadas em tests/dbFormat.test.ts.

import type { DbCell, DbDriver, DbResultColumn } from "./dbApi";
import { highlightSql } from "./dbSqlHighlight.ts";

const BREAK = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP BY",
  "ORDER BY",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "UNION",
  "UNION ALL",
  "EXCEPT",
  "INTERSECT",
  "INSERT INTO",
  "VALUES",
  "UPDATE",
  "DELETE FROM",
  "SET",
  "RETURNING",
  "WITH",
  "JOIN",
  "INNER JOIN",
  "LEFT JOIN",
  "LEFT OUTER JOIN",
  "RIGHT JOIN",
  "RIGHT OUTER JOIN",
  "FULL JOIN",
  "FULL OUTER JOIN",
  "CROSS JOIN",
  "ON",
]);

const HANG = new Set(["AND", "OR"]);

interface Piece {
  text: string;
  brk: boolean;
  hang: boolean;
  /** nome comum (não palavra-chave nem operador): "count" em count( */
  ident: boolean;
}

/** Formata o SQL: cláusulas em linhas novas, palavras-chave em maiúsculas. Textos e comentários ficam intactos. */
export function formatSql(src: string, driver: DbDriver = "postgres"): string {
  const pieces = piecesOf(src, driver);
  if (pieces.length === 0) return src.trim() ? src : "";
  let out = "";
  let depth = 0;
  let atStart = true;
  let prevIdent = false;
  for (const p of pieces) {
    // chamada de função: count(a) fica junto; IN (...) continua com espaço
    const glueLeft = p.text === "," || p.text === ")" || p.text === ";" || p.text === "." || (p.text === "(" && prevIdent);
    const glueRight = out.endsWith("(") || out.endsWith(".");
    if ((p.brk || p.hang) && depth === 0 && !atStart) {
      out = out.replace(/[ \t]+$/, "") + (p.hang ? "\n  " : "\n");
      atStart = true;
    }
    if (!atStart && !glueLeft && !glueRight) out += " ";
    out += p.text;
    atStart = false;
    prevIdent = p.ident;
    if (!isLiteral(p.text)) depth = Math.max(0, depth + countChar(p.text, "(") - countChar(p.text, ")"));
    if (p.text === "," && depth === 0) {
      out += "\n  ";
      atStart = true;
    }
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function piecesOf(src: string, driver: DbDriver): Piece[] {
  const raw = highlightSql(src, driver)
    .filter((s) => !(s.cls === "text" && !s.text.trim()))
    // "),", ").": cada sinal de pontuação vira uma peça (operadores como >= ficam inteiros)
    .flatMap((s) => (s.cls === "op" ? (s.text.match(/[(),;.]|[^(),;.\s]+/g) ?? []).map((t) => ({ text: t, cls: s.cls })) : [s]))
    .map((s) => ({
      // trechos comuns vêm com os espaços em volta (" b "): o formatador põe os seus
      text: s.cls === "kw" ? s.text.toUpperCase() : s.cls === "text" ? s.text.trim() : s.text,
      word: s.text.toUpperCase().replace(/\s+/g, " "),
      cls: s.cls,
    }));

  const out: Piece[] = [];
  for (let i = 0; i < raw.length; i++) {
    let text = raw[i].text;
    let word = raw[i].word;
    const take = (n: number) => {
      text = raw
        .slice(i, i + n)
        .map((t) => t.text)
        .join(" ");
      word = raw
        .slice(i, i + n)
        .map((t) => t.word)
        .join(" ");
      i += n - 1;
    };
    const next = raw[i + 1]?.word;
    const next2 = raw[i + 2]?.word;
    if ((word === "GROUP" || word === "ORDER") && next === "BY") take(2);
    else if (word === "INSERT" && next === "INTO") take(2);
    else if (word === "DELETE" && next === "FROM") take(2);
    else if (word === "UNION" && next === "ALL") take(2);
    else if ((word === "INNER" || word === "CROSS" || word === "NATURAL") && next === "JOIN") take(2);
    else if ((word === "LEFT" || word === "RIGHT" || word === "FULL") && next === "OUTER" && next2 === "JOIN") take(3);
    else if ((word === "LEFT" || word === "RIGHT" || word === "FULL") && next === "JOIN") take(2);
    out.push({ text, brk: BREAK.has(word), hang: HANG.has(word), ident: (raw[i].cls === "text" || raw[i].cls === "fn") && /[\w"`\]]$/.test(text) });
  }
  return out;
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

function isLiteral(text: string): boolean {
  return text.startsWith("'") || text.startsWith('"') || text.startsWith("`") || text.startsWith("--") || text.startsWith("/*") || text.startsWith("$");
}

/** Plano de execução, sem executar a consulta (exceto o que o próprio EXPLAIN do servidor faça). */
export function explainSql(driver: DbDriver, sql: string): string {
  const s = sql.trim().replace(/;+\s*$/, "");
  if (!s || /^explain\b/i.test(s)) return s;
  switch (driver) {
    case "mysql":
      return `EXPLAIN\n${s}`;
    case "sqlite":
      return `EXPLAIN QUERY PLAN\n${s}`;
    case "sqlserver":
      // SET SHOWPLAN tem que ser a única instrução do lote: separa com GO
      return `SET SHOWPLAN_TEXT ON\nGO\n${s}\nGO\nSET SHOWPLAN_TEXT OFF`;
    default:
      return `EXPLAIN\n${s}`;
  }
}

function quoteIdent(name: string, driver: DbDriver): string {
  if (driver === "mysql") return "`" + name.replace(/`/g, "``") + "`";
  if (driver === "sqlserver") return "[" + name.replace(/]/g, "]]") + "]";
  return '"' + name.replace(/"/g, '""') + '"';
}

// Limites de célula do Go (db_exec.go dbMaxCellText / dbMaxCellBinary): o
// que passou disso chega cortado, terminando em "…".
const CELL_TEXT_MAX = 64 << 10;
const CELL_BIN_MAX = 4 << 10;

/** Coluna binária (mesma regra do Go: dbLooksBinaryType). */
export function isBinaryType(t: string | undefined): boolean {
  const u = (t ?? "").toUpperCase();
  return u.includes("BLOB") || u.includes("BINARY") || u === "BYTEA" || u === "IMAGE";
}

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Célula que a grade recebeu cortada (o valor inteiro não está aqui). */
export function isCutCell(v: DbCell, type?: string): boolean {
  if (typeof v !== "string" || !v.endsWith("…")) return false;
  if (/^0x[0-9A-F]*…$/.test(v)) return v.length - 3 >= CELL_BIN_MAX * 2 || isBinaryType(type);
  return utf8Len(v) >= CELL_TEXT_MAX;
}

/** "2026-09-30T12:34:56.5Z" -> "2026-09-30 12:34:56.5" (o MySQL estrito recusa o "T" e o "Z"). */
function mysqlDateTime(v: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)\d*(?:Z|[+-]\d{2}:\d{2})$/.exec(v);
  return m ? `${m[1]} ${m[2]}` : null;
}

/** Literal SQL de uma célula, ou null quando ela veio cortada. */
function sqlLiteral(v: DbCell, col: DbResultColumn, driver: DbDriver): string | null {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") {
    // SQL Server não tem TRUE/FALSE; no SQLite o booleano é 1/0
    if (driver === "sqlserver" || driver === "sqlite") return v ? "1" : "0";
    return v ? "TRUE" : "FALSE";
  }
  if (isCutCell(v, col.type)) return null;
  const hex = /^0x([0-9A-F]*)$/.exec(v);
  if (hex && isBinaryType(col.type)) {
    switch (driver) {
      case "postgres":
        return `'\\x${hex[1].toLowerCase()}'::bytea`;
      case "sqlite":
        return `X'${hex[1]}'`;
      default:
        return hex[1] ? `0x${hex[1]}` : "''"; // MySQL e SQL Server
    }
  }
  let text = v;
  if (driver === "mysql") text = mysqlDateTime(text) ?? text;
  let lit = text.replace(/'/g, "''");
  // MySQL (sql_mode padrão) lê \ como escape dentro de '...'
  if (driver === "mysql") lit = lit.replace(/\\/g, "\\\\");
  // N'...' guarda acentos e outros alfabetos em nvarchar
  return driver === "sqlserver" ? `N'${lit}'` : `'${lit}'`;
}

/** INSERTs do que está carregado na grade (não é um dump do banco inteiro). */
export function toInsertSQL(table: string, columns: DbResultColumn[], rows: DbCell[][], driver: DbDriver = "postgres"): string {
  if (columns.length === 0 || rows.length === 0) return "";
  const cols = columns.map((c) => quoteIdent(c.name || "coluna", driver)).join(", ");
  const into = quoteIdent(table || "resultado", driver);
  let cut = 0;
  const lines = rows.map((r) => {
    const vals = columns.map((c, i) => {
      const lit = sqlLiteral(r[i] ?? null, c, driver);
      if (lit === null) {
        cut++;
        return "NULL";
      }
      return lit;
    });
    return `INSERT INTO ${into} (${cols}) VALUES (${vals.join(", ")});`;
  });
  const warn = cut
    ? `-- ATENÇÃO: ${cut} célula(s) chegaram cortadas na grade (texto acima de 64 KB ou binário acima de 4 KB)\n-- e saíram como NULL. Para exportar o valor inteiro, consulte só essa linha e coluna.\n`
    : "";
  return warn + lines.join("\n") + "\n";
}

export function findSpans(src: string, query: string, caseSensitive: boolean): { start: number; end: number }[] {
  if (!query) return [];
  const hay = caseSensitive ? src : src.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const out: { start: number; end: number }[] = [];
  let i = 0;
  while (i <= hay.length - needle.length) {
    const at = hay.indexOf(needle, i);
    if (at < 0) break;
    out.push({ start: at, end: at + needle.length });
    i = at + Math.max(1, needle.length);
  }
  return out;
}

export function replaceAllText(src: string, query: string, repl: string, caseSensitive: boolean): { text: string; count: number } {
  const spans = findSpans(src, query, caseSensitive);
  if (spans.length === 0) return { text: src, count: 0 };
  let out = "";
  let prev = 0;
  for (const s of spans) {
    out += src.slice(prev, s.start) + repl;
    prev = s.end;
  }
  return { text: out + src.slice(prev), count: spans.length };
}
