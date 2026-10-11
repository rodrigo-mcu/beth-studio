import { useEffect, useRef, useState } from "react";
import { Bookmark, ChevronsDown, CircleHelp, CircleStop, History, Lock, LoaderCircle, Play, ScrollText, Search, Sparkles, Trash2, TriangleAlert, Wand2, Waypoints } from "lucide-react";
import { dbApi, type DbApiClient, type DbCatalog, type DbCell, type DbConfirmItem, type DbQueryResponse, type DbResult } from "@/lib/dbApi";
import { showsAllDatabases } from "@/lib/dbScope";
import { formatCount, formatMs, kindLabel, newQueryId, plural, resultSummary } from "@/lib/dbFormat";
import { explainSql, formatSql } from "@/lib/dbSqlFormat";
import { ALL_CONNECTIONS, deleteSaved, loadQueryStore, pushHistory, savedFor, saveQuery, writeQueryStore, type DbQueryStore } from "@/lib/dbQueryStore";
import { cn } from "@/lib/utils";
import { useSqlCatalog } from "@/lib/useSqlCatalog";
import { DbSqlEditor, type DbSqlEditorHandle } from "./DbSqlEditor";
import { DbResultGrid } from "./DbResultGrid";
import { DbDeleteDialog } from "./DbDeleteDialog";
import { DbHistoryDialog } from "./DbHistoryDialog";
import { buildDeletes, deleteBlocker } from "@/lib/dbChanges";
import { DbExportButtons } from "./DbExportButtons";
import { DbConfirmDialog } from "./DbConfirmDialog";

const ROW_CHOICES = [100, 1000, 5000, 10000];
const TIMEOUT_CHOICES = [15, 60, 300, 600];

interface PendingConfirm {
  token: string;
  text: string;
  statements: DbConfirmItem[];
  danger: boolean;
  total: number;
}

/** Editor de consultas + resultados de uma conexão. */
export function DbQueryPanel({
  conn,
  catalog,
  initialConnId,
  initialDatabase,
  initialSql,
  onNotice,
  onTitle,
}: {
  conn: DbApiClient;
  catalog: DbCatalog;
  initialConnId: string;
  initialDatabase?: string;
  initialSql?: string;
  onNotice: (m: string) => void;
  onTitle?: (t: string) => void;
}) {
  const [connId, setConnId] = useState(initialConnId);
  const [database, setDatabase] = useState(initialDatabase ?? "");
  const [databases, setDatabases] = useState<string[]>([]);
  const [sql, setSql] = useState(initialSql ?? "");
  const [maxRows, setMaxRows] = useState(catalog.limits.default_rows);
  const [timeoutS, setTimeoutS] = useState(catalog.limits.default_timeout_s);
  const [running, setRunning] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const [resp, setResp] = useState<DbQueryResponse | null>(null);
  const [results, setResults] = useState<DbResult[]>([]);
  const [active, setActive] = useState(0);
  const [loadingMore, setLoadingMore] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [queries, setQueries] = useState<DbQueryStore>({ history: [], saved: [] });
  const [library, setLibrary] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [askOn, setAskOn] = useState(false);
  const [question, setQuestion] = useState("");
  const [assistBusy, setAssistBusy] = useState(false);
  const [assistAnswer, setAssistAnswer] = useState("");
  const [assistSQL, setAssistSQL] = useState("");
  const [pickedRows, setPickedRows] = useState<DbCell[][]>([]);
  const [delOpen, setDelOpen] = useState(false);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState("");
  const driver = catalog.connections.find((x) => x.id === connId)?.driver ?? "postgres";
  const { catalog: sqlCatalog, ensure } = useSqlCatalog(conn, connId, driver, database || undefined, sql);
  const [saveName, setSaveName] = useState("");
  const [saveAll, setSaveAll] = useState(true); // padrão: vale para todas as conexões
  const saveNameRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<DbSqlEditorHandle>(null);
  const openCursors = useRef<Set<string>>(new Set());

  useEffect(() => {
    const local = loadQueryStore();
    setQueries(local);
    void dbApi
      .queries(conn)
      .then((r) => {
        const remote = r.saved ?? [];
        const extra = local.saved.filter((q) => !remote.some((s) => s.connId === q.connId && s.name === q.name));
        setQueries({ history: local.history, saved: [...remote, ...extra] });
        for (const q of extra) {
          if (q.name) void dbApi.saveQuery(conn, q.connId, q.name, q.sql).catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }, [conn]);

  const remember = (text: string) => {
    setQueries((s) => {
      const next = pushHistory(s, connId, text);
      writeQueryStore(next);
      return next;
    });
  };

  const keep = () => {
    const name = saveName.trim();
    if (!name || !sql.trim()) return;
    const scope = saveAll ? ALL_CONNECTIONS : connId;
    const next = saveQuery(queries, scope, name, sql);
    setQueries(next);
    writeQueryStore({ ...next, saved: [] });
    void dbApi
      .saveQuery(conn, scope, name, sql)
      .then((r) => setQueries((s) => ({ ...s, saved: r.saved ?? [] })))
      .catch((e) => onNotice(e instanceof Error ? e.message : String(e)));
    setSaveName("");
    onNotice(saveAll ? "Consulta salva para todas as conexões" : "Consulta salva nesta conexão");
  };
  const c = catalog.connections.find((x) => x.id === connId);
  const info = catalog.drivers.find((d) => d.id === c?.driver);
  const readOnly = !!c?.read_only || catalog.app_read_only;

  const titleRef = useRef(onTitle);
  titleRef.current = onTitle;
  const connName = c?.name;
  useEffect(() => titleRef.current?.(connName ?? "Consulta"), [connName]);

  const pinnedDb = c?.database?.trim() ?? "";
  const listAllDbs = showsAllDatabases(!!info?.has_database_level, pinnedDb);
  useEffect(() => {
    setDatabases([]);
    if (!c || !info?.has_database_level) return;
    if (!listAllDbs) {
      if (pinnedDb) setDatabase((d) => d || pinnedDb);
      return;
    }
    dbApi
      .databases(conn, c.id)
      .then((r) => {
        setDatabases(r.databases);
        setDatabase((d) => d || r.current);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, connId, listAllDbs, pinnedDb]);

  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [running]);

  const closeCursors = () => {
    for (const id of openCursors.current) void dbApi.close(conn, id).catch(() => {});
    openCursors.current.clear();
  };
  useEffect(() => () => closeCursors(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const dbParam = () => {
    // o banco padrão da conexão não precisa ir (o Go reaproveita o pool)
    if (!info?.has_database_level) return "";
    return database;
  };

  const execute = async (text: string, confirmToken?: string) => {
    if (!c || !text.trim()) return;
    if (!confirmToken) remember(text);
    closeCursors();
    const qid = newQueryId();
    setRunning(qid);
    setStartedAt(Date.now());
    setNow(Date.now());
    try {
      const r = await dbApi.query(conn, {
        id: c.id,
        database: dbParam(),
        sql: text,
        max_rows: maxRows,
        timeout_s: timeoutS,
        confirm: confirmToken,
        query_id: qid,
      });
      if (r.needs_confirm && r.confirm_token) {
        setConfirm({ token: r.confirm_token, text, statements: r.statements ?? [], danger: !!r.danger, total: r.total ?? 1 });
        return;
      }
      setResp(r);
      const res = r.results ?? [];
      setResults(res);
      for (const x of res) if (x.more_id) openCursors.current.add(x.more_id);
      // mostra o último conjunto com linhas (ou o último)
      let pick = res.length - 1;
      for (let i = res.length - 1; i >= 0; i--)
        if (res[i].has_rows) {
          pick = i;
          break;
        }
      setActive(Math.max(0, pick));
    } catch (e) {
      setResp({ error: e instanceof Error ? e.message : String(e) });
      setResults([]);
    } finally {
      setRunning(null);
    }
  };

  const run = () => {
    if (running) return;
    const t = editorRef.current?.runnableText() ?? { text: sql, selection: false };
    void execute(t.text);
  };

  const cancel = () => {
    if (running) void dbApi.cancel(conn, running).catch(() => {});
    if (loadingMore) void dbApi.cancel(conn, loadingMore).catch(() => {});
  };

  const loadMore = async (idx: number) => {
    const r = results[idx];
    if (!r?.more_id || loadingMore) return;
    const id = r.more_id;
    setLoadingMore(id);
    try {
      const m = await dbApi.more(conn, id, maxRows, timeoutS);
      if (m.error) {
        onNotice(m.error);
        setResults((rs) => rs.map((x, k) => (k === idx ? { ...x, has_more: false, more_id: undefined } : x)));
        openCursors.current.delete(id);
        return;
      }
      if (!m.has_more) openCursors.current.delete(id);
      setResults((rs) =>
        rs.map((x, k) =>
          k === idx
            ? {
                ...x,
                rows: x.rows.concat(m.rows),
                has_more: m.has_more,
                more_id: m.has_more ? x.more_id : undefined,
                truncated: (m.truncated as DbResult["truncated"]) || (m.has_more ? x.truncated : ""),
                truncated_cells: (x.truncated_cells ?? 0) + (m.truncated_cells ?? 0),
              }
            : x,
        ),
      );
    } catch (e) {
      onNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(null);
    }
  };

  const assist = (mode: "fix" | "ask") => {
    const text = editorRef.current?.runnableText().text ?? sql;
    if (mode === "fix" && !text.trim()) return;
    if (mode === "ask" && !question.trim()) return;
    setAssistBusy(true);
    setAssistAnswer("");
    setAssistSQL("");
    setAskOn(true);
    void dbApi
      .assist(conn, { id: connId, mode, sql: text, question: mode === "ask" ? question : "", database: database || undefined })
      .then((r) => {
        setAssistSQL(r.sql || "");
        setAssistAnswer(r.answer || (mode === "fix" ? "" : "Sem resposta."));
        if (mode === "fix" && !r.sql) setAssistAnswer("O modelo não devolveu SQL.");
      })
      .catch((e: Error) => onNotice(e.message))
      .finally(() => setAssistBusy(false));
  };

  const cur = results[active];
  const editCols = (() => {
    if (!cur?.edit || c?.read_only || catalog.app_read_only || resp?.read_only) return undefined;
    const allowed = new Set(cur.edit.columns);
    const s = new Set<string>();
    for (const col of cur.columns ?? []) if (allowed.has(col.name)) s.add(col.name);
    return s.size ? s : undefined;
  })();
  const saveCell = async (row: DbCell[], column: string, value: string | null) => {
    const edit = cur?.edit;
    if (!edit || !cur) return;
    const where: Record<string, DbCell> = {};
    for (const name of edit.pk) {
      const i = (cur.columns ?? []).findIndex((col) => col.name === name);
      if (i < 0) throw new Error("a chave primária não está no resultado");
      where[name] = row[i] ?? null;
    }
    await dbApi.updateCell(conn, {
      id: connId,
      database: database || undefined,
      schema: edit.schema,
      table: edit.table,
      column,
      value,
      null: value === null,
      where,
    });
    const ci = (cur.columns ?? []).findIndex((col) => col.name === column);
    setResults((rs) =>
      rs.map((r, idx) => {
        if (idx !== active || !r.rows) return r;
        return { ...r, rows: r.rows.map((rr) => (rr === row ? rr.map((cell, j) => (j === ci ? value : cell)) : rr)) };
      }),
    );
    onNotice("Registro atualizado");
  };

  const readOnlyNow = !!c?.read_only || catalog.app_read_only || !!resp?.read_only;
  const delBlock = readOnlyNow ? "Esta conexão é somente leitura." : deleteBlocker(cur?.edit?.pk, cur?.columns);
  const doDelete = async () => {
    const edit = cur?.edit;
    if (!edit || !cur?.columns || delBusy) return;
    setDelBusy(true);
    setDelErr("");
    try {
      const deletes = buildDeletes(pickedRows, cur.columns, edit.pk);
      const r = await dbApi.applyRows(conn, {
        id: connId,
        database: database || undefined,
        schema: edit.schema,
        table: edit.table,
        deletes,
        updates: [],
        inserts: [],
      });
      if (r.error) {
        setDelErr(`Nada foi apagado. ${r.error}`);
        return;
      }
      const gone = new Set(pickedRows);
      setResults((rs) => rs.map((x, idx) => (idx === active && x.rows ? { ...x, rows: x.rows.filter((row) => !gone.has(row)) } : x)));
      setPickedRows([]);
      setDelOpen(false);
      onNotice(`${plural(r.deleted ?? deletes.length, "linha apagada", "linhas apagadas")}`);
    } catch (e) {
      setDelErr(`Nada foi apagado. ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDelBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* barra */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-[12px]">
        <select
          className="max-w-[240px] rounded border border-border bg-bg-panel px-1.5 py-1 text-text-1"
          value={connId}
          title="Conexão"
          disabled={!!running}
          onChange={(e) => {
            closeCursors();
            setConnId(e.target.value);
            setDatabase("");
            setResults([]);
            setResp(null);
          }}
        >
          {catalog.connections.map((x) => (
            <option key={x.id} value={x.id}>
              {x.group ? `${x.group} / ` : ""}
              {x.name}
            </option>
          ))}
        </select>
        {info?.has_database_level && pinnedDb && (
          <span
            className="max-w-[200px] truncate rounded border border-border bg-bg-panel px-1.5 py-1 font-mono text-text-1"
            title="Banco inicial desta conexão"
          >
            {pinnedDb}
          </span>
        )}
        {listAllDbs && databases.length > 0 && (
          <select
            className="max-w-[200px] rounded border border-border bg-bg-panel px-1.5 py-1 text-text-1"
            value={database}
            title="Banco"
            disabled={!!running}
            onChange={(e) => setDatabase(e.target.value)}
          >
            {databases.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        )}
        {c?.color && <span className="h-3 w-3 rounded-full" style={{ background: c.color }} />}
        {readOnly && (
          <span className="flex items-center gap-1 rounded bg-status-warn/15 px-1.5 py-0.5 text-[11px] text-status-warn" title="Só consultas de leitura; tudo é desfeito ao final">
            <Lock size={11} /> somente leitura
          </span>
        )}
        {running ? (
          <button className="flex items-center gap-1.5 rounded bg-[#DC2626] px-3 py-1 font-semibold text-white hover:bg-[#B91C1C]" onClick={cancel}>
            <CircleStop size={14} /> Cancelar
          </button>
        ) : (
          <button
            className="flex items-center gap-1.5 rounded bg-accent px-3 py-1 font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
            disabled={!c || !sql.trim()}
            onClick={run}
            title="Executar (Ctrl+Enter). Com texto selecionado, executa só a seleção."
          >
            <Play size={14} /> Executar
          </button>
        )}
        {!running && c && (
          <>
            <button
              className="rounded px-2 py-1 text-text-2 hover:bg-bg-hover hover:text-text-1 disabled:opacity-40"
              disabled={!sql.trim()}
              title="Formatar o SQL"
              onClick={() => setSql(formatSql(sql, c.driver).replace(/\n$/, ""))}
            >
              <Sparkles size={14} />
            </button>
            <button
              className="rounded px-2 py-1 text-text-2 hover:bg-bg-hover hover:text-text-1 disabled:opacity-40"
              disabled={!sql.trim()}
              title="Plano de execução (não altera dados)"
              onClick={() => {
                const t = editorRef.current?.runnableText().text || sql;
                void execute(explainSql(c.driver, t));
              }}
            >
              <Waypoints size={14} />
            </button>
            <button className="rounded px-2 py-1 text-text-2 hover:bg-bg-hover hover:text-text-1" title="Localizar e substituir (Ctrl+F)" onClick={() => editorRef.current?.openFind()}>
              <Search size={14} />
            </button>
            <button
              className="rounded px-2 py-1 text-text-2 hover:bg-bg-hover hover:text-text-1"
              title="Salvar esta consulta com um nome (para usar em qualquer banco)"
              onClick={() => {
                setLibrary(true);
                window.setTimeout(() => saveNameRef.current?.focus(), 0);
              }}
            >
              <Bookmark size={14} />
            </button>
            <button
              className="rounded px-2 py-1 text-text-2 hover:bg-bg-hover hover:text-text-1"
              title="Histórico geral: tudo o que foi executado, em todas as conexões, com busca"
              onClick={() => setHistoryOpen(true)}
            >
              <ScrollText size={14} />
            </button>
            <button
              className="rounded px-2 py-1 text-text-2 hover:bg-bg-hover hover:text-text-1"
              title="Consultas salvas e histórico"
              onClick={() => setLibrary((v) => !v)}
            >
              <History size={14} />
            </button>
            <button
              className="rounded px-2 py-1 text-text-2 hover:bg-bg-hover hover:text-text-1 disabled:opacity-40"
              disabled={!sql.trim() || assistBusy}
              title="Corrigir a sintaxe com o modelo do assistente de banco"
              onClick={() => assist("fix")}
            >
              <Wand2 size={14} />
            </button>
            <button
              className={`rounded px-2 py-1 hover:bg-bg-hover hover:text-text-1 ${askOn ? "bg-accent-soft text-text-1" : "text-text-2"}`}
              title="Perguntar ao assistente sobre este banco ou este SQL"
              onClick={() => setAskOn((v) => !v)}
            >
              <CircleHelp size={14} />
            </button>
          </>
        )}
        {running && (
          <span className="flex items-center gap-1 text-text-2">
            <LoaderCircle size={13} className="animate-spin" /> {formatMs(Math.max(0, now - startedAt))}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2 text-text-2">
          <label className="flex items-center gap-1" title="Linhas trazidas por vez em cada resultado (o resto vem em “Carregar mais”)">
            linhas
            <select className="rounded border border-border bg-bg-panel px-1 py-0.5 text-text-1" value={maxRows} onChange={(e) => setMaxRows(Number(e.target.value))}>
              {ROW_CHOICES.filter((n) => n <= catalog.limits.max_rows).map((n) => (
                <option key={n} value={n}>
                  {formatCount(n)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1" title="Tempo máximo; passou disso a consulta é cancelada no banco">
            tempo máx.
            <select className="rounded border border-border bg-bg-panel px-1 py-0.5 text-text-1" value={timeoutS} onChange={(e) => setTimeoutS(Number(e.target.value))}>
              {TIMEOUT_CHOICES.filter((n) => n <= catalog.limits.max_timeout_s).map((n) => (
                <option key={n} value={n}>
                  {n < 60 ? `${n} s` : `${n / 60} min`}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {library && c && (
        <div className="max-h-44 shrink-0 overflow-auto border-b border-border bg-bg-panel px-3 py-2 text-[12px]">
          <div className="mb-1 flex items-center gap-2">
            <Bookmark size={13} className="text-accent-text" />
            <input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") keep();
              }}
              ref={saveNameRef}
              placeholder="Nome para salvar esta consulta"
              className="h-7 min-w-0 flex-1 rounded border border-border bg-bg-term px-2 text-text-1 outline-none focus:border-accent"
            />
            <select
              value={saveAll ? "all" : "one"}
              onChange={(e) => setSaveAll(e.target.value === "all")}
              className="h-7 rounded border border-border bg-bg-term px-1 text-text-1"
              title="Onde a consulta salva aparece"
            >
              <option value="all">Todas as conexões</option>
              <option value="one">Só esta conexão</option>
            </select>
            <button className="rounded bg-bg-hover px-2 py-1 text-text-1 hover:bg-border disabled:opacity-40" disabled={!saveName.trim() || !sql.trim()} onClick={keep}>
              Salvar
            </button>
          </div>
          {savedFor(queries, connId).length > 0 && <div className="mb-0.5 text-[11px] text-text-3">Salvas</div>}
          {savedFor(queries, connId)
            .map((s) => (
              <div key={s.id} className="group flex items-center gap-1">
                <button className="min-w-0 flex-1 truncate py-0.5 text-left text-text-1 hover:underline" title={s.sql} onClick={() => setSql(s.sql)}>
                  {s.name}
                </button>
                <span className="shrink-0 rounded bg-bg-hover px-1.5 text-[10px] text-text-3">{s.connId === ALL_CONNECTIONS ? "todas" : "esta conexão"}</span>
                <button
                  className="rounded px-1 text-text-3 opacity-0 hover:text-status-err group-hover:opacity-100"
                  title="Apagar"
                  onClick={() => {
                    setQueries((cur) => deleteSaved(cur, s.id));
                    void dbApi
                      .deleteQuery(conn, s.id)
                      .then((r) => setQueries((cur) => ({ ...cur, saved: r.saved ?? [] })))
                      .catch(() => undefined);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          <div className="mb-0.5 mt-1 text-[11px] text-text-3">Histórico</div>
          {queries.history.filter((h) => h.connId === connId).length === 0 && <div className="text-text-3">Nenhuma consulta nesta conexão ainda.</div>}
          {queries.history
            .filter((h) => h.connId === connId)
            .slice(0, 15)
            .map((h) => (
              <button key={h.id} className="block w-full truncate py-0.5 text-left font-mono text-[11px] text-text-2 hover:text-text-1" title={h.sql} onClick={() => setSql(h.sql)}>
                {h.sql.replace(/\s+/g, " ")}
              </button>
            ))}
        </div>
      )}

      {askOn && c && (
        <div className="mx-2 mb-1 shrink-0 rounded border border-border bg-bg-panel px-2 py-1.5 text-[12px]">
          <div className="flex items-center gap-1">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  assist("ask");
                }
              }}
              placeholder="Pergunta sobre este banco ou este SQL"
              className="h-7 min-w-0 flex-1 rounded border border-border bg-bg-term px-2 text-text-1 outline-none focus:border-accent"
            />
            <button className="rounded bg-bg-hover px-2 py-1 text-text-1 hover:bg-border disabled:opacity-40" disabled={assistBusy || !question.trim()} onClick={() => assist("ask")}>
              {assistBusy ? "…" : "Perguntar"}
            </button>
            <button className="rounded px-1 text-text-3 hover:text-text-1" title="Fechar" onClick={() => setAskOn(false)}>
              ✕
            </button>
          </div>
          {(assistAnswer || assistSQL) && (
            <div className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-words text-text-1" style={{ userSelect: "text" }}>
              {assistAnswer}
              {assistSQL && (
                <div className="mt-1">
                  <button
                    className="rounded bg-accent px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-accent-hover"
                    onClick={() => editorRef.current?.replaceRunnable(assistSQL)}
                  >
                    Usar este SQL
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* editor */}
      <div className="h-[38%] min-h-[120px] shrink-0 p-2">
        {c ? (
          <DbSqlEditor ref={editorRef} value={sql} onChange={setSql} driver={c.driver} onRun={run} disabled={false} catalog={sqlCatalog} onMissing={ensure} />
        ) : (
          <div className="flex h-full items-center justify-center text-text-3">Escolha uma conexão.</div>
        )}
      </div>

      {/* resultados */}
      <div className="flex min-h-0 flex-1 flex-col border-t border-border">
        {resp?.error && (
          <div className="flex items-start gap-2 border-b border-status-err/40 bg-status-err/10 px-3 py-2 text-[12px] text-status-err" style={{ userSelect: "text" }}>
            <TriangleAlert size={14} className="mt-0.5 shrink-0" />
            <span className="whitespace-pre-wrap break-words">
              {resp.error_statement != null && <b>Instrução {resp.error_statement + 1}: </b>}
              {resp.error}
              {resp.blocked && resp.blocked.length > 0 && (
                <span className="mt-1 block font-mono text-[11px] text-text-2">
                  {resp.blocked.map((b) => `#${b.index + 1} (${kindLabel(b.kind)}): ${b.sql.split("\n")[0].slice(0, 160)}`).join("\n")}
                </span>
              )}
            </span>
          </div>
        )}
        {results.length > 0 && (
          <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-2 pt-1">
            {results.map((r, i) => (
              <button
                key={i}
                className={cn(
                  "shrink-0 rounded-t border border-b-0 px-2.5 py-1 text-[11px]",
                  i === active ? "border-border bg-bg-card text-text-1" : "border-transparent text-text-3 hover:text-text-1",
                )}
                title={r.sql}
                onClick={() => setActive(i)}
              >
                {r.has_rows ? `Resultado ${i + 1}` : `Comando ${r.statement + 1}`}
                <span className="ml-1.5 text-text-3">
                  {r.has_rows ? plural(r.rows.length, "linha", "linhas") + (r.has_more ? "+" : "") : r.affected != null ? `${formatCount(r.affected)} afetadas` : "ok"}
                </span>
              </button>
            ))}
            <span className="ml-auto shrink-0 pb-1 text-[11px] text-text-3">
              {resp?.elapsed_ms != null && `total ${formatMs(resp.elapsed_ms)}`}
              {resp?.rolled_back && " · transação de leitura desfeita"}
              {resp?.session_reset && " · conexão descartada ao final (tinha BEGIN/SET/USE)"}
            </span>
          </div>
        )}
        {cur ? (
          <>
            <div className="flex items-center gap-2 px-3 py-1 text-[11px] text-text-2">
              <span className="truncate font-mono text-text-3" title={cur.sql}>
                {cur.sql}
              </span>
              <span className="shrink-0">{resultSummary(cur)}</span>
              {cur.truncated_cells ? <span className="shrink-0 text-status-warn">{cur.truncated_cells} células longas cortadas</span> : null}
              {cur.has_rows && (
                <button
                  className="flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-text-2 hover:bg-bg-hover hover:text-status-err disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-2"
                  disabled={!!delBlock || pickedRows.length === 0}
                  title={delBlock || (pickedRows.length ? "Apagar as linhas marcadas (pede confirmação)" : "Marque linhas clicando no número delas (Shift+clique marca um intervalo; clique no # marca todas)")}
                  onClick={() => {
                    setDelErr("");
                    setDelOpen(true);
                  }}
                >
                  <Trash2 size={13} /> Apagar{pickedRows.length ? ` ${pickedRows.length}` : ""}
                </button>
              )}
              <div className="ml-auto shrink-0">
                <DbExportButtons base={c?.name ?? "consulta"} table="resultado" driver={c?.driver} columns={cur.columns} rows={cur.rows} onNotice={onNotice} />
              </div>
            </div>
            <div className="min-h-0 flex-1">
              {cur.has_rows && cur.columns ? (
                <DbResultGrid
                  columns={cur.columns}
                  rows={cur.rows}
                  pkColumns={cur.edit ? new Set(cur.edit.pk) : undefined}
                  editable={editCols}
                  onSave={editCols ? saveCell : undefined}
                  onSelectRows={delBlock ? undefined : setPickedRows}
                  onNotice={onNotice}
                />
              ) : (
                <div className="p-4 text-[12px] text-text-2">{resultSummary(cur)}</div>
              )}
            </div>
            {cur.has_more && cur.more_id && (
              <div className="flex items-center gap-2 border-t border-border px-3 py-1.5 text-[12px]">
                <button
                  className="flex items-center gap-1.5 rounded bg-bg-hover px-3 py-1 text-text-1 hover:bg-border disabled:opacity-50"
                  disabled={!!loadingMore}
                  onClick={() => void loadMore(active)}
                >
                  {loadingMore ? <LoaderCircle size={13} className="animate-spin" /> : <ChevronsDown size={13} />} Carregar mais {formatCount(maxRows)}
                </button>
                <span className="text-text-3">
                  há mais linhas; o cursor fica aberto por alguns minutos (até {formatCount(catalog.limits.max_total_rows)} linhas no total)
                </span>
              </div>
            )}
          </>
        ) : (
          !resp?.error && (
            <div className="flex flex-1 items-center justify-center text-[12px] text-text-3">
              {running ? "Executando…" : "Os resultados aparecem aqui. Várias instruções separadas por ; geram vários resultados."}
            </div>
          )
        )}
      </div>

      {historyOpen && (
        <DbHistoryDialog
          conn={conn}
          connections={catalog.connections}
          currentConnId={connId}
          onNotice={onNotice}
          onClose={() => setHistoryOpen(false)}
          onUseSqlOnly={(e) => {
            setSql(e.sql);
            setHistoryOpen(false);
          }}
          onUse={(e) => {
            if (e.connId !== connId) {
              closeCursors();
              setConnId(e.connId);
              setResults([]);
              setResp(null);
            }
            setDatabase(e.database);
            setSql(e.sql);
            setHistoryOpen(false);
          }}
        />
      )}

      {delOpen && c && cur?.edit && cur.columns && (
        <DbDeleteDialog
          connName={c.name}
          connColor={c.color}
          database={dbParam() || c.database}
          table={`${cur.edit.schema && cur.edit.schema !== "main" ? cur.edit.schema + "." : ""}${cur.edit.table}`}
          pk={cur.edit.pk}
          columns={cur.columns}
          rows={pickedRows}
          busy={delBusy}
          error={delErr}
          onCancel={() => setDelOpen(false)}
          onConfirm={() => void doDelete()}
        />
      )}

      {confirm && c && (
        <DbConfirmDialog
          connName={c.name}
          connColor={c.color}
          database={dbParam() || c.database}
          statements={confirm.statements}
          total={confirm.total}
          danger={confirm.danger}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const p = confirm;
            setConfirm(null);
            void execute(p.text, p.token);
          }}
        />
      )}
    </div>
  );
}
