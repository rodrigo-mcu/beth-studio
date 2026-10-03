import { useEffect, useMemo, useRef, useState } from "react";
import { dbApi, type DbApiClient, type DbDriver } from "./dbApi";
import type { SqlCatalog, SqlColumnInfo, SqlTableInfo } from "./dbSqlComplete";

const SYSTEM = new Set(["information_schema", "pg_catalog", "pg_toast", "sys", "guest", "mysql", "performance_schema"]);

function fallbackSchema(driver: DbDriver) {
  if (driver === "sqlite") return "main";
  if (driver === "sqlserver") return "dbo";
  return "public";
}

/** Tabelas do banco aberto e colunas sob demanda, para o autocomplete. */
export function useSqlCatalog(conn: DbApiClient, connId: string, driver: DbDriver, database: string | undefined, sql: string) {
  const [schemas, setSchemas] = useState<string[]>([]);
  const [defaultSchema, setDefaultSchema] = useState("");
  const [tables, setTables] = useState<SqlTableInfo[]>([]);
  const cols = useRef(new Map<string, SqlColumnInfo[]>());
  const inflight = useRef(new Set<string>());
  const [ver, setVer] = useState(0);

  useEffect(() => {
    let dead = false;
    cols.current = new Map();
    setTables([]);
    setSchemas([]);
    const db = database?.trim() || undefined;
    void (async () => {
      try {
        const sch = await dbApi.schemas(conn, connId, db);
        if (dead) return;
        const current = sch.current || fallbackSchema(driver);
        const names = [current, ...sch.schemas.filter((s) => s !== current && !SYSTEM.has(s.toLowerCase()))].slice(0, 3);
        setSchemas(sch.schemas.filter((s) => !SYSTEM.has(s.toLowerCase())));
        setDefaultSchema(current);
        const all: SqlTableInfo[] = [];
        for (const schema of names) {
          const r = await dbApi.objects(conn, connId, db, schema);
          if (dead) return;
          for (const o of r.objects) all.push({ schema, name: o.name, type: o.type });
          if (all.length > 1500) break;
        }
        setTables(all.slice(0, 1500));
      } catch {
        if (!dead) {
          setTables([]);
          setSchemas([]);
        }
      }
    })();
    return () => {
      dead = true;
    };
  }, [conn, connId, driver, database]);

  const ensure = (pairs: { schema: string; table: string }[]) => {
    const db = database?.trim() || undefined;
    for (const p of pairs.slice(0, 8)) {
      const key = `${p.schema.toLowerCase()}.${p.table.toLowerCase()}`;
      if (cols.current.has(key) || inflight.current.has(key)) continue;
      inflight.current.add(key);
      void dbApi
        .columns(conn, connId, db, p.schema, p.table)
        .then((r) => {
          cols.current.set(
            key,
            r.columns.map((c) => ({ name: c.name, type: c.type, pk: c.pk })),
          );
          setVer((v) => v + 1);
        })
        .catch(() => {
          cols.current.set(key, []);
        })
        .finally(() => inflight.current.delete(key));
    }
  };

  useEffect(() => {
    const re = /(?:from|join|update|into|table)\s+(?:([A-Za-z_][\w]*)\s*\.\s*)?([A-Za-z_][\w]*)/gi;
    const want: { schema: string; table: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) && want.length < 8) {
      const schema = m[1] || defaultSchema;
      const table = m[2];
      if (!table || !schema) continue;
      const known = tables.some((t) => t.name.toLowerCase() === table.toLowerCase() && t.schema.toLowerCase() === schema.toLowerCase());
      if (known) want.push({ schema, table });
    }
    if (want.length) ensure(want);
    // ensure is stable enough for this debounce; tables/defaultSchema gate the names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sql, tables, defaultSchema]);

  const catalog = useMemo<SqlCatalog>(() => {
    return {
      defaultSchema,
      schemas,
      tables: tables.map((t) => {
        const hit = cols.current.get(`${t.schema.toLowerCase()}.${t.name.toLowerCase()}`);
        return hit ? { ...t, columns: hit } : t;
      }),
    };
  }, [defaultSchema, schemas, tables, ver]);

  return { catalog, ensure };
}
