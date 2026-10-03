// Realce de sintaxe SQL para o editor leve (DbSqlEditor). Só divide o texto
// em pedaços com uma classe; a concatenação dos pedaços é sempre o texto
// original (o editor desenha isso por baixo de um <textarea> transparente).

import type { DbDriver } from "./dbApi";

export type SqlTokClass = "kw" | "fn" | "str" | "ident" | "num" | "com" | "param" | "op" | "text";

export interface SqlSeg {
  text: string;
  cls: SqlTokClass;
}

export const SQL_KEYWORDS = new Set(
  (
    "ADD ALL ALTER ANALYZE AND ANY AS ASC ATTACH AUTOINCREMENT BEGIN BETWEEN BIGINT BINARY BIT BLOB BOOLEAN BY CALL CASCADE CASE CAST " +
    "CHAR CHARACTER CHECK COLLATE COLUMN COMMENT COMMIT CONSTRAINT CONFLICT COPY CREATE CROSS CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP " +
    "DATABASE DATE DATETIME DECIMAL DECLARE DEFAULT DEFERRABLE DELETE DESC DESCRIBE DETACH DISTINCT DO DOUBLE DROP ELSE END ESCAPE EXCEPT " +
    "EXEC EXECUTE EXISTS EXPLAIN FALSE FETCH FIRST FLOAT FOR FOREIGN FROM FULL FUNCTION GO GRANT GROUP HAVING IF ILIKE IN INDEX INNER INSERT " +
    "INT INTEGER INTERSECT INTERVAL INTO IS JOIN JSON JSONB KEY LAST LATERAL LEFT LIKE LIMIT LOCK MERGE NATURAL NEXT NOT NOTHING NULL NULLS " +
    "NUMERIC NVARCHAR OF OFFSET ON ONLY OR ORDER OUTER OUTPUT OVER PARTITION PRAGMA PRIMARY PROCEDURE REAL RECURSIVE REFERENCES RELEASE " +
    "RENAME REPLACE RETURNING REVOKE RIGHT ROLLBACK ROW ROWS SAVEPOINT SCHEMA SELECT SEQUENCE SERIAL SET SHOW SMALLINT TABLE TEMP TEMPORARY " +
    "TEXT THEN TIME TIMESTAMP TO TOP TRANSACTION TRIGGER TRUE TRUNCATE UNION UNIQUE UNSIGNED UPDATE USE USING UUID VACUUM VALUES VARCHAR " +
    "VIEW WHEN WHERE WINDOW WITH WITHOUT"
  ).split(" "),
);

const KEYWORDS = SQL_KEYWORDS;

/** Divide o SQL em pedaços com classe de realce. */
export function highlightSql(src: string, driver: DbDriver = "postgres"): SqlSeg[] {
  const out: SqlSeg[] = [];
  const push = (text: string, cls: SqlTokClass) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.cls === cls && (cls === "text" || cls === "op")) last.text += text;
    else out.push({ text, cls });
  };
  const n = src.length;
  let i = 0;
  const isIdStart = (c: string) => /[A-Za-z_À-￿]/.test(c);
  const isId = (c: string) => /[A-Za-z0-9_$À-￿]/.test(c);
  const until = (from: number, close: string, doubled: boolean, backslash: boolean): number => {
    let j = from;
    while (j < n) {
      const c = src[j];
      if (backslash && c === "\\") {
        j += 2;
        continue;
      }
      if (src.startsWith(close, j)) {
        if (doubled && src.startsWith(close + close, j)) {
          j += close.length * 2;
          continue;
        }
        return j + close.length;
      }
      j++;
    }
    return n;
  };
  while (i < n) {
    const c = src[i];
    const c2 = src.slice(i, i + 2);
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      let j = i;
      while (j < n && /[ \t\r\n]/.test(src[j])) j++;
      push(src.slice(i, j), "text");
      i = j;
    } else if (c2 === "--" || (c === "#" && driver === "mysql")) {
      let j = src.indexOf("\n", i);
      if (j < 0) j = n;
      push(src.slice(i, j), "com");
      i = j;
    } else if (c2 === "/*") {
      const j = until(i + 2, "*/", false, false);
      push(src.slice(i, j), "com");
      i = j;
    } else if (c === "'") {
      const back = driver === "mysql" || (driver === "postgres" && i > 0 && /[Ee]/.test(src[i - 1]));
      const j = until(i + 1, "'", true, back);
      push(src.slice(i, j), "str");
      i = j;
    } else if (c === '"') {
      const j = until(i + 1, '"', true, driver === "mysql");
      push(src.slice(i, j), driver === "mysql" ? "str" : "ident");
      i = j;
    } else if (c === "`" && (driver === "mysql" || driver === "sqlite")) {
      const j = until(i + 1, "`", true, false);
      push(src.slice(i, j), "ident");
      i = j;
    } else if (c === "[" && (driver === "sqlserver" || driver === "sqlite")) {
      const j = until(i + 1, "]", true, false);
      push(src.slice(i, j), "ident");
      i = j;
    } else if (c === "$" && driver === "postgres") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 64));
      if (m && !(i > 0 && isId(src[i - 1]))) {
        const tag = m[0];
        const k = src.indexOf(tag, i + tag.length);
        const j = k < 0 ? n : k + tag.length;
        push(src.slice(i, j), "str");
        i = j;
      } else {
        let j = i + 1;
        while (j < n && /[0-9]/.test(src[j])) j++;
        push(src.slice(i, j), j > i + 1 ? "param" : "op");
        i = j;
      }
    } else if ((c === "@" && driver === "sqlserver") || (c === ":" && isIdStart(src[i + 1] ?? "") && src[i - 1] !== ":")) {
      let j = i + 1;
      while (j < n && (isId(src[j]) || src[j] === "@")) j++;
      push(src.slice(i, j), "param");
      i = j;
    } else if (c === "?") {
      push(c, "param");
      i++;
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      if (src.slice(i, i + 2).toLowerCase() === "0x") {
        j += 2;
        while (j < n && /[0-9A-Fa-f]/.test(src[j])) j++;
      } else {
        while (j < n && /[0-9.]/.test(src[j])) j++;
        if (j < n && /[eE]/.test(src[j]) && /[-+0-9]/.test(src[j + 1] ?? "")) {
          j += 2;
          while (j < n && /[0-9]/.test(src[j])) j++;
        }
      }
      if (j < n && isIdStart(src[j])) {
        // "1abc" is an identifier-ish word, not a number
        while (j < n && isId(src[j])) j++;
        push(src.slice(i, j), "text");
      } else push(src.slice(i, j), "num");
      i = j;
    } else if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isId(src[j])) j++;
      const word = src.slice(i, j);
      let k = j;
      while (k < n && (src[k] === " " || src[k] === "\t")) k++;
      const up = word.toUpperCase();
      if (KEYWORDS.has(up) && !(i > 0 && src[i - 1] === ".")) push(word, "kw");
      else if (src[k] === "(") push(word, "fn");
      else push(word, "text");
      i = j;
    } else {
      push(c, "op");
      i++;
    }
  }
  return out;
}
