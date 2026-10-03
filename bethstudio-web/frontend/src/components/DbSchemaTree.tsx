import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  Braces,
  ChevronDown,
  ChevronRight,
  Database,
  Eye,
  FileCode2,
  Hash,
  KeyRound,
  Layers,
  ListTree,
  LoaderCircle,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Table2,
} from "lucide-react";
import { dbApi, type DbApiClient, type DbCatalog, type DbColumn, type DbConnView, type DbIndex, type DbObject, type DbRoutine } from "@/lib/dbApi";
import { driverLabel, formatCount } from "@/lib/dbFormat";
import { schemaFolders, type SchemaFolderId } from "@/lib/dbSchemaFolders";
import { showsAllDatabases } from "@/lib/dbScope";
import { ALL_CONNECTIONS } from "@/lib/dbQueryStore";
import { cn } from "@/lib/utils";

export interface DbTableTarget {
  connId: string;
  database?: string;
  schema: string;
  table: string;
  type: "table" | "view";
}

type Node =
  | { kind: "databases"; list: string[]; current: string }
  | { kind: "schemas"; list: string[]; current: string }
  | { kind: "objects"; list: DbObject[]; routines: DbRoutine[] }
  | { kind: "queries"; list: { id: string; name: string; sql: string; all: boolean }[] }
  | { kind: "columns"; columns: DbColumn[]; indexes: DbIndex[] };

interface Loaded {
  loading?: boolean;
  error?: string;
  node?: Node;
}

/**
 * Árvore do banco: conexão → banco → schema →
 * Tables / Views / Materialized Views / Functions / Queries.
 */
export function DbSchemaTree({
  conn,
  catalog,
  onOpenTable,
  onNewQuery,
  onEdit,
  onNew,
}: {
  conn: DbApiClient;
  catalog: DbCatalog;
  onOpenTable: (t: DbTableTarget) => void;
  onNewQuery: (connId: string, database?: string, sql?: string) => void;
  onEdit: (c: DbConnView) => void;
  onNew: () => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [data, setData] = useState<Record<string, Loaded>>({});
  const [filter, setFilter] = useState("");

  const load = useCallback(
    async (key: string, fn: () => Promise<Node>) => {
      setData((d) => ({ ...d, [key]: { ...d[key], loading: true, error: undefined } }));
      try {
        const node = await fn();
        setData((d) => ({ ...d, [key]: { node } }));
      } catch (e) {
        setData((d) => ({ ...d, [key]: { error: e instanceof Error ? e.message : String(e) } }));
      }
    },
    [],
  );

  const toggle = (key: string, fn: () => Promise<Node>, force = false) => {
    const willOpen = force || !open[key];
    setOpen((o) => ({ ...o, [key]: willOpen }));
    if (willOpen && (force || (!data[key]?.node && !data[key]?.loading))) void load(key, fn);
  };

  const refreshConn = (c: DbConnView) => {
    setData((d) => {
      const next: Record<string, Loaded> = {};
      for (const [k, v] of Object.entries(d)) if (!k.startsWith(`${c.id}|`)) next[k] = v;
      return next;
    });
    toggle(`${c.id}|`, rootLoader(c), true);
  };

  const hasDbLevel = (c: DbConnView) => !!catalog.drivers.find((d) => d.id === c.driver)?.has_database_level;

  const rootLoader = (c: DbConnView) => async (): Promise<Node> => {
    // PostgreSQL/SQL Server listam os bancos que o usuário pode acessar (o
    // inicial vem em destaque). Se a listagem falhar ou vier vazia, abre só o
    // banco inicial.
    const pinned = c.database?.trim() || undefined;
    if (showsAllDatabases(hasDbLevel(c))) {
      try {
        const r = await dbApi.databases(conn, c.id);
        if (r.databases.length > 0) return { kind: "databases", list: r.databases, current: r.current };
      } catch (e) {
        if (!pinned) throw e;
      }
    }
    const r = await dbApi.schemas(conn, c.id, pinned);
    return { kind: "schemas", list: r.schemas, current: r.current };
  };

  const groups = useMemo(() => {
    const m = new Map<string, DbConnView[]>();
    for (const c of catalog.connections) {
      const g = c.group || "";
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(c);
    }
    return [...m.entries()];
  }, [catalog.connections]);

  const f = filter.trim().toLowerCase();

  const row = (extra?: string) =>
    cn("group flex h-[26px] cursor-pointer items-center gap-1 rounded pr-1 text-[12px] text-text-1 hover:bg-bg-hover", extra) as string;
  const pad = (depth: number) => ({ paddingLeft: 4 + depth * 14 });

  const status = (key: string, depth: number) => {
    const l = data[key];
    if (l?.loading)
      return (
        <div className="flex h-6 items-center gap-1 text-[11px] text-text-3" style={pad(depth)}>
          <LoaderCircle size={12} className="animate-spin" /> carregando…
        </div>
      );
    if (l?.error)
      return (
        <div className="break-words py-1 text-[11px] text-status-err" style={pad(depth)} title={l.error}>
          {l.error}
        </div>
      );
    return null;
  };

  const chevron = (key: string) => (open[key] ? <ChevronDown size={13} className="shrink-0 text-text-3" /> : <ChevronRight size={13} className="shrink-0 text-text-3" />);

  const folderIcon = (id: SchemaFolderId) => {
    if (id === "view" || id === "matview") return <Eye size={13} className="shrink-0 text-[#c586c0]" />;
    if (id === "function") return <Braces size={13} className="shrink-0 text-[#4fc1ff]" />;
    if (id === "query") return <FileCode2 size={13} className="shrink-0 text-[#ce9178]" />;
    return <Table2 size={13} className="shrink-0 text-accent-text" />;
  };

  const renderObjectRow = (c: DbConnView, database: string | undefined, schema: string, o: DbObject, depth: number) => {
    const okey = `${c.id}|${database ?? ""}|${schema}|${o.type}|${o.name}`;
    const openable = o.type === "table" || o.type === "view" || o.type === "matview";
    return (
      <div key={okey}>
        <div
          className={row()}
          style={pad(depth)}
          title={openable ? `${o.name}\nClique: abrir os dados · seta: ver colunas` : o.name}
          onClick={() => openable && onOpenTable({ connId: c.id, database, schema, table: o.name, type: o.type === "view" ? "view" : "table" })}
        >
          {openable ? (
            <span
              className="rounded hover:bg-bg-panel"
              onClick={(e) => {
                e.stopPropagation();
                toggle(okey, async () => {
                  const r = await dbApi.columns(conn, c.id, database, schema, o.name);
                  return { kind: "columns", columns: r.columns, indexes: r.indexes };
                });
              }}
            >
              {chevron(okey)}
            </span>
          ) : (
            <span className="w-[13px] shrink-0" />
          )}
          {o.type === "table" ? <Table2 size={13} className="shrink-0 text-accent-text" /> : <Eye size={13} className="shrink-0 text-[#c586c0]" />}
          <span className="truncate">{o.name}</span>
          {o.rows_estimate != null && o.type === "table" && (
            <span className="ml-auto shrink-0 pl-1 text-[10px] text-text-3" title="estimativa de linhas">
              ~{formatCount(o.rows_estimate)}
            </span>
          )}
        </div>
        {open[okey] && renderColumns(okey, depth)}
      </div>
    );
  };

  const renderObjects = (c: DbConnView, database: string | undefined, schema: string, depth: number) => {
    const key = `${c.id}|${database ?? ""}|${schema}`;
    const node = data[key]?.node;
    const qkey = `${key}|query`;
    return (
      <>
        {status(key, depth)}
        {node?.kind === "objects" &&
          schemaFolders(c.driver).map((folder) => {
            const fkey = `${key}|${folder.id}`;
            const needle = f;
            let rows: ReactNode = null;
            let count = 0;
            if (folder.id === "function") {
              const list = node.routines.filter((r) => !needle || `${r.name} ${r.args}`.toLowerCase().includes(needle));
              count = list.length;
              rows = list.map((r) => {
                const sig = `${r.name}(${r.args})`;
                return (
                  <div key={sig} className="flex h-[24px] items-center gap-1 text-[12px] text-text-1" style={pad(depth + 1)} title={sig}>
                    <span className="w-[13px] shrink-0" />
                    <Braces size={13} className="shrink-0 text-[#4fc1ff]" />
                    <span className="truncate font-mono text-[11px]">{sig}</span>
                  </div>
                );
              });
            } else if (folder.id === "query") {
              const qn = data[qkey]?.node;
              const list = (qn?.kind === "queries" ? qn.list : []).filter((q) => !needle || q.name.toLowerCase().includes(needle));
              count = list.length;
              rows = (
                <>
                  {status(qkey, depth + 1)}
                  {list.map((q) => (
                    <div
                      key={q.id}
                      className={row()}
                      style={pad(depth + 1)}
                      title={q.sql}
                      onClick={() => onNewQuery(c.id, database, q.sql)}
                    >
                      <span className="w-[13px] shrink-0" />
                      <FileCode2 size={13} className="shrink-0 text-[#ce9178]" />
                      <span className="truncate">{q.name}</span>
                      {q.all && <span className="ml-auto shrink-0 pl-1 text-[10px] text-text-3" title="vale para todas as conexões">todas</span>}
                    </div>
                  ))}
                  {open[fkey] && qn?.kind === "queries" && list.length === 0 && (
                    <div className="py-0.5 text-[11px] text-text-3" style={pad(depth + 1)}>
                      {needle ? "nada com esse nome" : "nenhuma consulta salva"}
                    </div>
                  )}
                </>
              );
            } else {
              const list = node.list.filter((o) => o.type === folder.id && (!needle || o.name.toLowerCase().includes(needle)));
              count = list.length;
              rows = list.map((o) => renderObjectRow(c, database, schema, o, depth + 1));
            }
            if (needle && count === 0) return null;
            const expanded = !!open[fkey] || (!!needle && count > 0);
            return (
              <div key={folder.id}>
                <div
                  className={row()}
                  style={pad(depth)}
                  onClick={() => {
                    if (folder.id === "query") {
                      toggle(fkey, async () => {
                        const r = await dbApi.queries(conn);
                        const list = (r.saved ?? [])
                          .filter((s) => s.name && (s.connId === ALL_CONNECTIONS || s.connId === c.id))
                          .map((s) => ({ id: s.id, name: s.name ?? "", sql: s.sql, all: s.connId === ALL_CONNECTIONS }))
                          .sort((a, b) => a.name.localeCompare(b.name));
                        return { kind: "queries", list };
                      });
                      return;
                    }
                    setOpen((o) => ({ ...o, [fkey]: !o[fkey] }));
                  }}
                >
                  {expanded ? <ChevronDown size={13} className="shrink-0 text-text-3" /> : <ChevronRight size={13} className="shrink-0 text-text-3" />}
                  {folderIcon(folder.id)}
                  <span className="truncate">{folder.label}</span>
                </div>
                {expanded && rows}
                {expanded && folder.id !== "query" && folder.id !== "function" && count === 0 && (
                  <div className="py-0.5 text-[11px] text-text-3" style={pad(depth + 1)}>
                    vazio
                  </div>
                )}
                {expanded && folder.id === "function" && count === 0 && (
                  <div className="py-0.5 text-[11px] text-text-3" style={pad(depth + 1)}>
                    {needle ? "nada com esse nome" : "nenhuma"}
                  </div>
                )}
              </div>
            );
          })}
      </>
    );
  };

  const renderColumns = (key: string, depth: number) => {
    const node = data[key]?.node;
    return (
      <>
        {status(key, depth)}
        {node?.kind === "columns" && (
          <>
            {node.columns.map((col) => (
              <div
                key={col.name}
                className="flex h-[22px] items-center gap-1 text-[11px] text-text-2"
                style={pad(depth + 1)}
                title={`${col.name} ${col.type}${col.nullable ? "" : " NOT NULL"}${col.default != null ? ` DEFAULT ${col.default}` : ""}`}
              >
                {col.pk ? <KeyRound size={11} className="shrink-0 text-status-warn" /> : <Hash size={11} className="shrink-0 text-text-3" />}
                <span className="truncate text-text-1">{col.name}</span>
                <span className="ml-auto shrink-0 truncate pl-1 font-mono text-[10px] text-text-3">
                  {col.type.toLowerCase()}
                  {col.nullable ? "" : " ·nn"}
                </span>
              </div>
            ))}
            {node.indexes.length > 0 && (
              <div className="pt-0.5">
                <div className="flex h-[20px] items-center gap-1 text-[10px] uppercase tracking-wide text-text-3" style={pad(depth + 1)}>
                  <ListTree size={11} /> índices
                </div>
                {node.indexes.map((ix) => (
                  <div
                    key={ix.name}
                    className="flex h-[20px] items-center gap-1 text-[11px] text-text-2"
                    style={pad(depth + 2)}
                    title={`${ix.name}${ix.primary ? " (chave primária)" : ix.unique ? " (único)" : ""}: ${(ix.columns ?? []).join(", ")}`}
                  >
                    <span className="truncate">{ix.name}</span>
                    <span className="ml-auto shrink-0 truncate pl-1 font-mono text-[10px] text-text-3">
                      {ix.primary ? "PK " : ix.unique ? "único " : ""}({(ix.columns ?? []).join(", ")})
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </>
    );
  };

  const renderSchemas = (c: DbConnView, database: string | undefined, key: string, depth: number) => {
    const node = data[key]?.node;
    return (
      <>
        {status(key, depth)}
        {node?.kind === "schemas" &&
          node.list.map((s) => {
            const skey = `${c.id}|${database ?? ""}|${s}`;
            const loader = async (): Promise<Node> => {
              const r = await dbApi.objects(conn, c.id, database, s);
              return { kind: "objects", list: r.objects, routines: r.routines ?? [] };
            };
            return (
              <div key={s}>
                <div className={row()} style={pad(depth)} onClick={() => toggle(skey, loader)}>
                  {chevron(skey)}
                  <Layers size={13} className="shrink-0 text-text-2" />
                  <span className={cn("truncate", s === node.current && "font-semibold")}>{s}</span>
                </div>
                {open[skey] && renderObjects(c, database, s, depth + 1)}
              </div>
            );
          })}
      </>
    );
  };

  const renderRoot = (c: DbConnView) => {
    const key = `${c.id}|`;
    const node = data[key]?.node;
    if (node?.kind === "schemas") return renderSchemas(c, undefined, key, 1);
    return (
      <>
        {status(key, 1)}
        {node?.kind === "databases" &&
          node.list.map((db) => {
            const dkey = `${c.id}|${db}|`;
            const database = db === node.current ? undefined : db;
            const loader = async (): Promise<Node> => {
              const r = await dbApi.schemas(conn, c.id, database);
              return { kind: "schemas", list: r.schemas, current: r.current };
            };
            return (
              <div key={db}>
                <div className={row()} style={pad(1)} onClick={() => toggle(dkey, loader)}>
                  {chevron(dkey)}
                  <Database size={13} className="shrink-0 text-text-2" />
                  <span className={cn("truncate", db === node.current && "font-semibold")}>{db}</span>
                  <button
                    className="ml-auto hidden shrink-0 rounded p-0.5 text-text-3 hover:bg-bg-panel hover:text-text-1 group-hover:block"
                    title={`Nova consulta em ${db}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onNewQuery(c.id, database);
                    }}
                  >
                    <FileCode2 size={13} />
                  </button>
                </div>
                {open[dkey] && renderSchemas(c, database, dkey, 2)}
              </div>
            );
          })}
      </>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border p-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filtrar…"
          className="min-w-0 flex-1 rounded border border-border bg-bg-panel px-2 py-1 text-[12px] text-text-1 outline-none focus:border-accent"
          style={{ userSelect: "text" }}
        />
        <button className="flex shrink-0 items-center gap-1 rounded bg-accent px-2 py-1 text-[12px] font-semibold text-white hover:bg-accent-hover" onClick={onNew} title="Nova conexão">
          <Plus size={13} /> Conexão
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1">
        {catalog.connections.length === 0 && (
          <div className="p-4 text-center text-[12px] text-text-3">
            Nenhuma conexão salva.
            <br />
            Clique em <b className="text-text-2">+ Conexão</b> para começar.
          </div>
        )}
        {groups.map(([g, list]) => (
          <div key={g || "-"} className="mb-1">
            {g && <div className="px-1 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-3">{g}</div>}
            {list.map((c) => {
              const key = `${c.id}|`;
              return (
                <div key={c.id}>
                  <div
                    className={row("h-[28px]")}
                    style={pad(0)}
                    title={`${c.name} — ${driverLabel(c.driver)}${c.driver === "sqlite" ? `\n${c.file}` : `\n${c.user ? c.user + "@" : ""}${c.host}:${c.port}${c.database ? "/" + c.database : ""}`}${c.read_only ? "\nsomente leitura" : ""}`}
                    onClick={() => toggle(key, rootLoader(c))}
                  >
                    {chevron(key)}
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-border-strong" style={{ background: c.color || "transparent" }} />
                    <span className="truncate font-semibold">{c.name}</span>
                    {c.read_only && <Lock size={11} className="shrink-0 text-status-warn" aria-label="somente leitura" />}
                    <span className="ml-auto flex shrink-0 items-center">
                      <span className="text-[10px] text-text-3 group-hover:hidden">{driverLabel(c.driver).split(" ")[0]}</span>
                      <span className="hidden items-center group-hover:flex">
                        <button
                          className="rounded p-0.5 text-text-3 hover:bg-bg-panel hover:text-text-1"
                          title="Nova consulta"
                          onClick={(e) => {
                            e.stopPropagation();
                            onNewQuery(c.id);
                          }}
                        >
                          <FileCode2 size={13} />
                        </button>
                        <button
                          className="rounded p-0.5 text-text-3 hover:bg-bg-panel hover:text-text-1"
                          title="Recarregar"
                          onClick={(e) => {
                            e.stopPropagation();
                            refreshConn(c);
                          }}
                        >
                          <RefreshCw size={13} />
                        </button>
                        <button
                          className="rounded p-0.5 text-text-3 hover:bg-bg-panel hover:text-text-1"
                          title="Editar conexão"
                          onClick={(e) => {
                            e.stopPropagation();
                            onEdit(c);
                          }}
                        >
                          <Pencil size={13} />
                        </button>
                      </span>
                    </span>
                  </div>
                  {open[key] && renderRoot(c)}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
