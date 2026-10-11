// Banco de dados: tipos e chamadas das rotas /api/db/* (db_api.go).
// A senha nunca volta do Go: a página só vê has_password/password_mask.

import type { DbQueryEntry } from "./dbQueryStore";

/** HTTP do banco: o Studio (Connection) ou a janela própria (makeHttpClient). */
export interface DbApiClient {
  api<T>(path: string, body?: unknown): Promise<T>;
}

export type DbDriver = "postgres" | "mysql" | "sqlserver" | "sqlite";

export interface DbDriverInfo {
  id: DbDriver;
  label: string;
  default_port?: number;
  ssl_modes?: string[];
  default_ssl?: string;
  file_based?: boolean;
  has_database_level?: boolean;
}

export interface DbConnConfig {
  id: string;
  name: string;
  group?: string;
  driver: DbDriver;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  ssl_mode?: string;
  file?: string;
  create_file?: boolean;
  read_only: boolean;
  color?: string;
  tunnel?: string;
}

export interface DbConnView extends DbConnConfig {
  has_password: boolean;
  password_mask?: string;
}

export interface DbLimits {
  default_timeout_s: number;
  max_timeout_s: number;
  default_rows: number;
  max_rows: number;
  max_total_rows: number;
  max_response_mb: number;
}

export interface DbCatalog {
  connections: DbConnView[];
  groups: string[];
  drivers: DbDriverInfo[];
  app_read_only: boolean;
  tunnel_ready: boolean;
  limits: DbLimits;
}

export interface DbObject {
  name: string;
  type: "table" | "view" | "matview";
  rows_estimate?: number;
}

export interface DbRoutine {
  name: string;
  args: string;
  kind: "function" | "procedure";
}

export interface DbColumn {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  pk: boolean;
}

export interface DbIndex {
  name: string;
  columns: string[] | null;
  unique: boolean;
  primary: boolean;
}

export type DbCell = string | number | boolean | null;

export interface DbResultColumn {
  name: string;
  type?: string;
}

export type DbStmtKind = "read" | "write" | "ddl" | "tx" | "session" | "other";

export interface DbEditInfo {
  schema: string;
  table: string;
  pk: string[];
  columns: string[];
}

export interface DbResult {
  statement: number;
  sql: string;
  kind: DbStmtKind;
  columns: DbResultColumn[] | null;
  rows: DbCell[][];
  /** Presente quando o SELECT é de uma tabela com chave primária. */
  edit?: DbEditInfo;
  has_rows: boolean;
  affected?: number;
  has_more: boolean;
  more_id?: string;
  truncated?: "rows" | "bytes" | "limit" | "";
  truncated_cells?: number;
  elapsed_ms: number;
}

/** Uma execução no histórico geral (todas as conexões e bancos). */
export interface DbHistoryEntry {
  id: string;
  connId: string;
  connName: string;
  driver: string;
  database: string;
  sql: string;
  at: string;
  ms: number;
  rows: number;
  error?: string;
}

export interface DbConfirmItem {
  index: number;
  sql: string;
  kind: DbStmtKind;
  danger: boolean;
  reason?: string;
}

export interface DbQueryResponse {
  results?: DbResult[];
  elapsed_ms?: number;
  error?: string;
  error_statement?: number;
  read_only?: boolean;
  rolled_back?: boolean;
  session_reset?: boolean;
  // confirmation needed
  needs_confirm?: boolean;
  confirm_token?: string;
  statements?: DbConfirmItem[];
  danger?: boolean;
  total?: number;
  // refused (read-only)
  blocked?: DbConfirmItem[];
}

export interface DbMoreResponse {
  rows: DbCell[][];
  has_more: boolean;
  truncated?: string;
  truncated_cells?: number;
  elapsed_ms: number;
  error?: string;
}

export type DbFilterOp = "eq" | "ne" | "lt" | "le" | "gt" | "ge" | "contains" | "starts" | "ends" | "null" | "notnull";

export interface DbFilter {
  column: string;
  op: DbFilterOp;
  value: string;
}

export interface DbSort {
  column: string;
  desc: boolean;
}

export interface DbTableResponse {
  columns: DbResultColumn[] | null;
  rows: DbCell[][];
  has_more: boolean;
  total?: number;
  truncated_cells?: number;
  elapsed_ms: number;
  error?: string;
}

export interface DbTestResponse {
  ok: boolean;
  version?: string;
  elapsed_ms?: number;
  error?: string;
  message?: string;
  /** só com list_databases */
  databases?: string[];
}

export const dbApi = {
  catalog: (c: DbApiClient) => c.api<DbCatalog>("/api/db/connections"),
  save: (c: DbApiClient, connection: Partial<DbConnConfig>, password?: string | null, clearPassword = false) =>
    c.api<{ connection: DbConnView }>("/api/db/connections/save", {
      connection,
      ...(password ? { password } : {}),
      clear_password: clearPassword,
    }),
  remove: (c: DbApiClient, id: string) => c.api<{ ok: boolean }>("/api/db/connections/delete", { id }),
  test: (c: DbApiClient, body: { id?: string; connection?: Partial<DbConnConfig>; password?: string; list_databases?: boolean }) =>
    c.api<DbTestResponse>("/api/db/test", body),
  databases: (c: DbApiClient, id: string) => c.api<{ databases: string[]; current: string }>("/api/db/databases", { id }),
  schemas: (c: DbApiClient, id: string, database?: string, system = false) =>
    c.api<{ schemas: string[]; current: string }>("/api/db/schemas", { id, database: database ?? "", system }),
  objects: (c: DbApiClient, id: string, database: string | undefined, schema: string) =>
    c.api<{ objects: DbObject[]; routines?: DbRoutine[] }>("/api/db/objects", { id, database: database ?? "", schema }),
  columns: (c: DbApiClient, id: string, database: string | undefined, schema: string, table: string) =>
    c.api<{ columns: DbColumn[]; indexes: DbIndex[] }>("/api/db/columns", { id, database: database ?? "", schema, table }),
  assist: (c: DbApiClient, body: { id: string; mode: "fix" | "ask"; sql?: string; question?: string; database?: string }) =>
    c.api<{ sql?: string; answer?: string; model?: string; ms?: number }>("/api/db/assist", body),
  table: (
    c: DbApiClient,
    body: {
      id: string;
      database?: string;
      schema: string;
      table: string;
      sort: DbSort[];
      filters: DbFilter[];
      limit: number;
      offset: number;
      count: boolean;
      query_id: string;
    },
  ) => c.api<DbTableResponse>("/api/db/table", body),
  updateCell: (
    c: DbApiClient,
    body: {
      id: string;
      database?: string;
      schema: string;
      table: string;
      column: string;
      value?: DbCell;
      null?: boolean;
      where: Record<string, DbCell>;
    },
  ) => c.api<{ ok: boolean; affected: number }>("/api/db/row", body),
  /** Aplica as alterações pendentes da grade numa transação (db_rows_apply.go). */
  applyRows: (
    c: DbApiClient,
    body: {
      id: string;
      database?: string;
      schema: string;
      table: string;
      deletes: { where: Record<string, DbCell> }[];
      updates: { where: Record<string, DbCell>; set: Record<string, string | null> }[];
      inserts: { values: Record<string, string | null> }[];
    },
  ) =>
    c.api<{ ok?: boolean; deleted?: number; updated?: number; inserted?: number; error?: string; change?: string; index?: number }>(
      "/api/db/apply",
      body,
    ),
  query: (
    c: DbApiClient,
    body: { id: string; database?: string; sql: string; max_rows: number; timeout_s: number; confirm?: string; query_id: string },
  ) => c.api<DbQueryResponse>("/api/db/query", body),
  more: (c: DbApiClient, moreId: string, maxRows: number, timeoutS: number) =>
    c.api<DbMoreResponse>("/api/db/more", { more_id: moreId, max_rows: maxRows, timeout_s: timeoutS }),
  cancel: (c: DbApiClient, queryId: string) => c.api<{ cancelled: boolean }>("/api/db/cancel", { query_id: queryId }),
  close: (c: DbApiClient, moreId: string) => c.api<{ ok: boolean }>("/api/db/close", { more_id: moreId }),
  queries: (c: DbApiClient) => c.api<{ saved: DbQueryEntry[] }>("/api/db/queries"),
  saveQuery: (c: DbApiClient, connId: string, name: string, sql: string) =>
    c.api<{ saved: DbQueryEntry[] }>("/api/db/queries/save", { connId, name, sql }),
  deleteQuery: (c: DbApiClient, id: string) => c.api<{ saved: DbQueryEntry[] }>("/api/db/queries/delete", { id }),
  history: (c: DbApiClient, body: { q?: string; connId?: string; failed?: boolean; limit?: number; offset?: number }) =>
    c.api<{ items: DbHistoryEntry[]; total: number }>("/api/db/history", body),
  deleteHistory: (c: DbApiClient, id: string) => c.api<{ ok: boolean }>("/api/db/history/delete", { id }),
  clearHistory: (c: DbApiClient) => c.api<{ ok: boolean }>("/api/db/history/clear", {}),
};
