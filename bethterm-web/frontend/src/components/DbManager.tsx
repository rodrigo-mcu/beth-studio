import { useCallback, useEffect, useRef, useState } from "react";
import { Database, Eye, FileCode2, Lock, Plus, Table2, X } from "lucide-react";
import { dbApi, type DbApiClient, type DbCatalog, type DbConnView } from "@/lib/dbApi";
import { cn } from "@/lib/utils";
import { isFrameless, startDrag, useWindowState, winCommand } from "@/lib/windowFrame";
import { DbSchemaTree, type DbTableTarget } from "./DbSchemaTree";
import { DbConnectionDialog } from "./DbConnectionDialog";
import { DbTableView } from "./DbTableView";
import { DbQueryPanel } from "./DbQueryPanel";
import { TopResizeEdges, WindowControls } from "./WindowControls";
import { DbThemeButton } from "./DbThemeButton";

type WorkTab =
  | { key: string; kind: "table"; target: DbTableTarget }
  | { key: string; kind: "query"; connId: string; database?: string; sql?: string; title: string };

let tabSeq = 0;

/**
 * "Banco de dados": conexões salvas, árvore de schemas, dados das tabelas e
 * editor de consultas, em abas. Roda na janela própria do sistema (botão na
 * barra de tarefas). Minimizar e maximizar mexem nessa janela; o X a fecha.
 */
export function DbManager({ conn, onClose }: { conn: DbApiClient; onClose: () => void }) {
  const win = useWindowState();
  const [catalog, setCatalog] = useState<DbCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tabs, setTabs] = useState<WorkTab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [editing, setEditing] = useState<DbConnView | null | "new">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);

  const reload = useCallback(async () => {
    try {
      setCatalog(await dbApi.catalog(conn));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [conn]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const showNotice = useCallback((m: string) => {
    setNotice(m);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3500);
  }, []);

  const openTable = (t: DbTableTarget) => {
    const key = `t:${t.connId}|${t.database ?? ""}|${t.schema}|${t.table}`;
    setTabs((ts) => (ts.some((x) => x.key === key) ? ts : [...ts, { key, kind: "table", target: t }]));
    setActive(key);
  };

  const newQuery = (connId?: string, database?: string, sql?: string) => {
    const id = connId ?? catalog?.connections[0]?.id;
    if (!id) {
      setEditing("new");
      return;
    }
    const key = `q:${++tabSeq}`;
    const name = catalog?.connections.find((c) => c.id === id)?.name ?? "Consulta";
    setTabs((ts) => [...ts, { key, kind: "query", connId: id, database, sql, title: name }]);
    setActive(key);
  };

  const closeTab = (key: string) => {
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.key === key);
      const next = ts.filter((t) => t.key !== key);
      if (active === key) setActive(next[Math.min(i, next.length - 1)]?.key ?? null);
      return next;
    });
  };

  const setQueryTitle = useCallback((key: string, title: string) => {
    setTabs((ts) => (ts.some((t) => t.key === key && t.kind === "query" && t.title !== title) ? ts.map((t) => (t.key === key && t.kind === "query" ? { ...t, title } : t)) : ts));
  }, []);

  const connOf = (id: string) => catalog?.connections.find((c) => c.id === id);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Banco de dados"
      className="fixed inset-0 z-[65] flex flex-col bg-bg-card text-[12px] text-text-1"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <TopResizeEdges state={win} />
      <header
        className={cn(
          "flex shrink-0 items-stretch border-b border-border bg-bg-raised pr-2 pt-1 select-none",
          isFrameless() && !win.active && "opacity-75",
        )}
      >
        <div
          className="flex min-w-0 flex-1 items-center gap-2 px-3"
          onMouseDown={startDrag}
          onDoubleClick={() => isFrameless() && winCommand("toggle")}
          title={isFrameless() ? "Arraste para mover a janela; duplo clique maximiza" : undefined}
        >
          <Database size={16} className="shrink-0 text-accent-text" />
          <span className="text-[15px] font-semibold">Banco de dados</span>
          {catalog?.app_read_only && (
            <span className="flex items-center gap-1 rounded bg-status-warn/15 px-1.5 py-0.5 text-[11px] text-status-warn">
              <Lock size={11} /> app em modo somente leitura
            </span>
          )}
          {notice && <span className="truncate text-[11px] text-status-ok">{notice}</span>}
          {loadError && <span className="truncate text-[11px] text-status-err">erro: {loadError}</span>}
        </div>
        <DbThemeButton conn={conn} />
        <WindowControls state={win} onClose={onClose} closeTitle="Fechar o banco de dados" />
      </header>

        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[290px] shrink-0 flex-col border-r border-border bg-bg-panel">
            {catalog ? (
              <DbSchemaTree
                conn={conn}
                catalog={catalog}
                onOpenTable={openTable}
                onNewQuery={(id, db, sql) => newQuery(id, db, sql)}
                onEdit={(c) => setEditing(c)}
                onNew={() => setEditing("new")}
              />
            ) : (
              <div className="p-4 text-text-3">{loadError ? "Não foi possível carregar." : "Carregando…"}</div>
            )}
          </aside>

          <main className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border bg-bg-panel px-1">
              {tabs.map((t) => {
                const c = connOf(t.kind === "table" ? t.target.connId : t.connId);
                const label = t.kind === "table" ? t.target.table : t.title;
                return (
                  <div
                    key={t.key}
                    className={cn(
                      "group flex h-8 max-w-[220px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t border border-b-0 px-2 text-[12px]",
                      active === t.key ? "border-border bg-bg-card text-text-1" : "border-transparent text-text-2 hover:bg-bg-hover",
                    )}
                    style={c?.color ? { boxShadow: `inset 0 2px 0 ${c.color}` } : undefined}
                    title={`${c?.name ?? ""}${t.kind === "table" ? ` · ${t.target.schema}.${t.target.table}` : ""}`}
                    onClick={() => setActive(t.key)}
                    onMouseDown={(e) => {
                      if (e.button === 1) {
                        e.preventDefault();
                        closeTab(t.key);
                      }
                    }}
                  >
                    {t.kind === "table" ? (
                      t.target.type === "view" ? (
                        <Eye size={13} className="shrink-0" />
                      ) : (
                        <Table2 size={13} className="shrink-0" />
                      )
                    ) : (
                      <FileCode2 size={13} className="shrink-0" />
                    )}
                    <span className="truncate">{label}</span>
                    <button
                      className="rounded p-0.5 text-text-3 opacity-60 hover:bg-bg-hover hover:text-text-1 group-hover:opacity-100"
                      title="Fechar aba"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(t.key);
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                );
              })}
              <button
                className="mb-1 ml-1 flex h-7 shrink-0 items-center gap-1 rounded px-2 text-text-2 hover:bg-bg-hover hover:text-text-1 disabled:opacity-40"
                disabled={!catalog}
                onClick={() => newQuery()}
                title="Nova consulta SQL"
              >
                <Plus size={13} /> Consulta
              </button>
            </div>

            <div className="relative min-h-0 flex-1">
              {catalog &&
                tabs.map((t) => (
                  <div key={t.key} className={cn("absolute inset-0 flex flex-col", active === t.key ? "" : "hidden")}>
                    {t.kind === "table" ? (
                      <DbTableView
                        conn={conn}
                        target={t.target}
                        driver={connOf(t.target.connId)?.driver ?? "postgres"}
                        readOnly={!!connOf(t.target.connId)?.read_only || catalog.app_read_only}
                        connName={connOf(t.target.connId)?.name ?? ""}
                        connColor={connOf(t.target.connId)?.color}
                        onNotice={showNotice}
                        onQuery={(sql) => newQuery(t.target.connId, t.target.database, sql)}
                      />
                    ) : (
                      <DbQueryPanel
                        conn={conn}
                        catalog={catalog}
                        initialConnId={t.connId}
                        initialDatabase={t.database}
                        initialSql={t.sql}
                        onNotice={showNotice}
                        onTitle={(title) => setQueryTitle(t.key, title)}
                      />
                    )}
                  </div>
                ))}
              {tabs.length === 0 && catalog && (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-text-3">
                  <Database size={36} className="opacity-40" />
                  {catalog.connections.length === 0 ? (
                    <>
                      <span>Nenhuma conexão ainda.</span>
                      <button className="flex items-center gap-1 rounded bg-accent px-3 py-1.5 font-semibold text-white hover:bg-accent-hover" onClick={() => setEditing("new")}>
                        <Plus size={14} /> Nova conexão
                      </button>
                    </>
                  ) : (
                    <>
                      <span>Clique numa tabela à esquerda para ver os dados, ou abra uma consulta.</span>
                      <button className="flex items-center gap-1 rounded bg-accent px-3 py-1.5 font-semibold text-white hover:bg-accent-hover" onClick={() => newQuery()}>
                        <FileCode2 size={14} /> Nova consulta
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </main>
        </div>

      {editing && catalog && (
        <DbConnectionDialog
          conn={conn}
          catalog={catalog}
          editing={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(c) => {
            setEditing(null);
            showNotice(`Conexão “${c.name}” salva`);
            void reload();
          }}
          onDeleted={(id) => {
            setEditing(null);
            setTabs((ts) => ts.filter((t) => (t.kind === "table" ? t.target.connId : t.connId) !== id));
            showNotice("Conexão excluída");
            void reload();
          }}
        />
      )}
    </div>
  );
}
