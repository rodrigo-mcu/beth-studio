// Pastas do schema, nesta ordem: Tables, Views, Materialized Views,
// Functions, Queries.

import type { DbDriver } from "./dbApi.ts";

export type SchemaFolderId = "table" | "view" | "matview" | "function" | "query";

export interface SchemaFolder {
  id: SchemaFolderId;
  label: string;
}

export function schemaFolders(driver: DbDriver): SchemaFolder[] {
  const out: SchemaFolder[] = [
    { id: "table", label: "Tables" },
    { id: "view", label: "Views" },
  ];
  if (driver === "postgres") out.push({ id: "matview", label: "Materialized Views" });
  if (driver !== "sqlite") out.push({ id: "function", label: "Functions" });
  out.push({ id: "query", label: "Queries" });
  return out;
}
