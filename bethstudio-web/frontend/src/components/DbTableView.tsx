import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, CircleStop, Copy, Filter, Hash, KeyRound, LoaderCircle, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { dbApi, type DbApiClient, type DbCell, type DbColumn, type DbDriver, type DbFilter, type DbIndex, type DbSort, type DbTableResponse } from "@/lib/dbApi";
import { FILTER_OPS, formatCount, formatMs, newQueryId, quoteIdent } from "@/lib/dbFormat";
import { cn } from "@/lib/utils";
import { addRow, buildApply, buildDeletes, changeCount, duplicateRow, emptyChanges, isAdded, type PendingChanges } from "@/lib/dbChanges";
import { DbResultGrid } from "./DbResultGrid";
import { DbExportButtons } from "./DbExportButtons";
import { DbDeleteDialog } from "./DbDeleteDialog";
import type { DbTableTarget } from "./DbSchemaTree";

const PAGE_SIZES = [100, 500, 1000, 5000];

/** Dados de uma tabela/view: página, ordenação e filtros feitos no banco. */
export function DbTableView({
  conn,
  target,
  driver,
  readOnly,
  connName,
  connColor,
  onNotice,
  onQuery,
}: {
  conn: DbApiClient;
  target: DbTableTarget;
  driver: DbDriver;
  readOnly: boolean;
  connName: string;
  connColor?: string;
  onNotice: (m: string) => void;
  onQuery: (sql: string) => void;
}) {
  const [tab, setTab] = useState<"data" | "structure">("data");
  const [cols, setCols] = useState<DbColumn[]>([]);
  const [indexes, setIndexes] = useState<DbIndex[]>([]);
  const [sort, setSort] = useState<DbSort[]>([]);
  const [filters, setFilters] = useState<DbFilter[]>([]);
  const [draft, setDraft] = useState<DbFilter[]>([]);
  const [pageSize, setPageSize] = useState(500);
  const [page, setPage] = useState(0);
  const [data, setData] = useState<DbTableResponse | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runId = useRef<string>("");
  // Alterações pendentes (Aplicar / Descartar)
  const [changes, setChanges] = useState<PendingChanges>(emptyChanges);
  const [selRow, setSelRow] = useState<DbCell[] | null>(null);
  const [focusRow, setFocusRow] = useState<DbCell[] | null>(null);
  const [applying, setApplying] = useState(false);
  const [pickedRows, setPickedRows] = useState<DbCell[][]>([]);
  const [delOpen, setDelOpen] = useState(false);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState("");
  const pending = changeCount(changes);
  /** enquanto há alteração pendente, não troca a página (perderia o que foi feito) */
  const blocked = () => {
    if (!pending) return false;
    onNotice("Aplique ou descarte as alterações antes");
    return true;
  };

  useEffect(() => {
    dbApi
      .columns(conn, target.connId, target.database, target.schema, target.table)
      .then((r) => {
        setCols(r.columns);
        setIndexes(r.indexes);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [conn, target]);

  const load = useCallback(
    async (withCount = false) => {
      const qid = newQueryId();
      runId.current = qid;
      setLoading(true);
      setError(null);
      try {
        const r = await dbApi.table(conn, {
          id: target.connId,
          database: target.database,
          schema: target.schema,
          table: target.table,
          sort,
          filters,
          limit: pageSize,
          offset: page * pageSize,
          count: withCount,
          query_id: qid,
        });
        if (runId.current !== qid) return;
        if (r.error) setError(r.error);
        else {
          setData(r);
          setChanges(emptyChanges());
          setSelRow(null);
          if (withCount && r.total != null) setTotal(r.total);
        }
      } catch (e) {
        if (runId.current === qid) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (runId.current === qid) setLoading(false);
      }
    },
    [conn, target, sort, filters, pageSize, page],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  // total muda quando os filtros mudam
  useEffect(() => setTotal(null), [filters, target]);

  const cancel = () => {
    if (runId.current) void dbApi.cancel(conn, runId.current).catch(() => {});
  };

  const onSort = (column: string, additive: boolean) => {
    if (blocked()) return;
    setPage(0);
    setSort((cur) => {
      const found = cur.find((s) => s.column === column);
      const others = additive ? cur.filter((s) => s.column !== column) : [];
      if (!found) return [...others, { column, desc: false }];
      if (!found.desc) return additive ? cur.map((s) => (s.column === column ? { ...s, desc: true } : s)) : [{ column, desc: true }];
      return others;
    });
  };
  const applyFilters = () => {
    if (blocked()) return;
    setPage(0);
    setFilters(draft.filter((f) => f.column && (f.op === "null" || f.op === "notnull" || f.value !== "")));
  };

  const pk = useMemo(() => new Set(cols.filter((c) => c.pk).map((c) => c.name)), [cols]);
  const editable = useMemo(() => {
    if (readOnly || pk.size === 0) return undefined;
    const s = new Set<string>();
    for (const c of cols) {
      const t = c.type.toUpperCase();
      if (t.includes("BLOB") || t.includes("BINARY") || t === "BYTEA" || t === "IMAGE") continue;
      s.add(c.name);
    }
    return s;
  }, [cols, pk.size, readOnly]);
  const rows = data?.rows ?? [];
  const resultCols = data?.columns ?? [];
  // Duplicar: não copia a chave (geralmente automática) nem binário (não editável)
  const dupSkip = useMemo(() => {
    const s = new Set(pk);
    for (const c of cols) {
      const t = c.type.toUpperCase();
      if (t.includes("BLOB") || t.includes("BINARY") || t === "BYTEA" || t === "IMAGE") s.add(c.name);
    }
    return s;
  }, [cols, pk]);
  const newRow = () => {
    const a = addRow(changes, resultCols.length);
    setChanges(a.changes);
    setFocusRow(a.row);
  };
  const dupRow = () => {
    if (!selRow) return;
    const a = duplicateRow(changes, selRow, resultCols, dupSkip);
    setChanges(a.changes);
    setFocusRow(a.row);
  };
  // linhas que o botão Apagar atinge: as marcadas (pelo número) ou, se não houver, a da célula selecionada
  const toDelete = useMemo(() => {
    const base = pickedRows.length ? pickedRows : selRow ? [selRow] : [];
    return base.filter((r) => !isAdded(changes, r));
  }, [pickedRows, selRow, changes]);
  const openDelete = () => {
    if (blocked() || toDelete.length === 0) return;
    setDelErr("");
    setDelOpen(true);
  };
  const doDelete = async () => {
    if (delBusy) return;
    setDelBusy(true);
    setDelErr("");
    try {
      const deletes = buildDeletes(toDelete, resultCols, [...pk]);
      const r = await dbApi.applyRows(conn, {
        id: target.connId,
        database: target.database,
        schema: target.schema,
        table: target.table,
        deletes,
        updates: [],
        inserts: [],
      });
      if (r.error) {
        setDelErr(`Nada foi apagado. ${r.error}`);
        return;
      }
      setDelOpen(false);
      setPickedRows([]);
      onNotice(`${r.deleted ?? deletes.length} linha${(r.deleted ?? deletes.length) > 1 ? "s apagadas" : " apagada"}`);
      await load(true);
    } catch (e) {
      setDelErr(`Nada foi apagado. ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDelBusy(false);
    }
  };
  const apply = async () => {
    if (!pending || applying) return;
    setApplying(true);
    setError(null);
    try {
      const body = buildApply(changes, rows, resultCols, [...pk]);
      const r = await dbApi.applyRows(conn, {
        id: target.connId,
        database: target.database,
        schema: target.schema,
        table: target.table,
        ...body,
      });
      if (r.error) {
        setError(`Nada foi gravado. ${r.error}`);
        return;
      }
      const parts = [
        r.updated ? `${r.updated} alterada${r.updated > 1 ? "s" : ""}` : "",
        r.inserted ? `${r.inserted} inserida${r.inserted > 1 ? "s" : ""}` : "",
        r.deleted ? `${r.deleted} apagada${r.deleted > 1 ? "s" : ""}` : "",
      ].filter(Boolean);
      onNotice(`Gravado: ${parts.join(", ")}`);
      setChanges(emptyChanges());
      await load(false);
    } catch (e) {
      setError(`Nada foi gravado. ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setApplying(false);
    }
  };
  const from = page * pageSize + 1;
  const title = `${target.schema && target.schema !== "main" ? target.schema + "." : ""}${target.table}`;
  const selectSql = useMemo(() => {
    const q = (s: string) => quoteIdent(driver, s);
    return `SELECT *\nFROM ${target.schema ? q(target.schema) + "." : ""}${q(target.table)}\n`;
  }, [target, driver]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
        <div className="flex rounded bg-bg-panel p-0.5 text-[12px]">
          {(["data", "structure"] as const).map((t) => (
            <button
              key={t}
              className={cn("rounded px-2.5 py-0.5", tab === t ? "bg-bg-hover text-text-1" : "text-text-2 hover:text-text-1")}
              onClick={() => setTab(t)}
            >
              {t === "data" ? "Dados" : "Estrutura"}
            </button>
          ))}
        </div>
        {tab === "data" && (
          <>
            <button
              className={cn(
                "flex items-center gap-1 rounded px-2 py-1 text-[12px] hover:bg-bg-hover",
                filters.length ? "text-accent-text" : "text-text-2",
              )}
              onClick={() => setDraft((d) => (d.length ? d : [...filters, { column: cols[0]?.name ?? "", op: "contains", value: "" }]))}
              title="Filtrar linhas (no banco)"
            >
              <Filter size={13} /> Filtros{filters.length ? ` (${filters.length})` : ""}
            </button>
            <button
              className="flex items-center gap-1 rounded px-2 py-1 text-[12px] text-text-2 hover:bg-bg-hover"
              onClick={() => !blocked() && void load(false)}
              title="Recarregar"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Recarregar
            </button>
            {loading && (
              <button className="flex items-center gap-1 rounded px-2 py-1 text-[12px] text-status-err hover:bg-bg-hover" onClick={cancel}>
                <CircleStop size={13} /> Cancelar
              </button>
            )}
            <button
              className="rounded px-2 py-1 text-[12px] text-text-2 hover:bg-bg-hover"
              title="Abrir um SELECT desta tabela no editor"
              onClick={() => onQuery(selectSql)}
            >
              Abrir no editor
            </button>
            {editable && (
              <div className="flex items-center gap-0.5 border-l border-border pl-2">
                <button className="flex items-center gap-1 rounded px-2 py-1 text-[12px] text-text-2 hover:bg-bg-hover hover:text-text-1" onClick={newRow} title="Nova linha (vai para o banco ao Aplicar)">
                  <Plus size={13} /> Nova linha
                </button>
                <button
                  className="flex items-center gap-1 rounded px-2 py-1 text-[12px] text-text-2 hover:bg-bg-hover hover:text-text-1 disabled:opacity-40"
                  disabled={!selRow}
                  onClick={dupRow}
                  title="Duplicar a linha selecionada (sem a chave)"
                >
                  <Copy size={13} /> Duplicar
                </button>
                <button
                  className="flex items-center gap-1 rounded px-2 py-1 text-[12px] text-text-2 hover:bg-bg-hover hover:text-status-err disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-2"
                  disabled={toDelete.length === 0}
                  onClick={openDelete}
                  title={`Apagar as linhas marcadas (pede confirmação; a chave é ${[...pk].join(" + ")}). Marque clicando no número da linha; Shift+clique marca um intervalo; clique no # marca todas.`}
                >
                  <Trash2 size={13} /> Apagar{toDelete.length > 1 ? ` ${toDelete.length}` : ""}
                </button>
              </div>
            )}
            {pending > 0 && (
              <div className="flex items-center gap-1.5 rounded bg-status-warn/15 px-2 py-0.5 text-[12px] text-text-1">
                <span>
                  {pending} alteraç{pending > 1 ? "ões" : "ão"} pendente{pending > 1 ? "s" : ""}
                </span>
                <button
                  className="flex items-center gap-1 rounded bg-accent px-2.5 py-0.5 font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
                  disabled={applying}
                  onClick={() => void apply()}
                  title="Gravar tudo no banco, numa transação (se uma falhar, nada é gravado)"
                >
                  {applying ? <LoaderCircle size={12} className="animate-spin" /> : <Check size={12} />} Aplicar
                </button>
                <button className="rounded px-2 py-0.5 text-text-2 hover:bg-bg-hover hover:text-text-1" disabled={applying} onClick={() => setChanges(emptyChanges())}>
                  Descartar
                </button>
              </div>
            )}
            <div className="ml-auto flex items-center gap-2 text-[12px] text-text-2">
              <DbExportButtons base={title} table={target.table} driver={driver} columns={data?.columns ?? null} rows={rows} onNotice={onNotice} />
              <select
                className="rounded border border-border bg-bg-panel px-1 py-0.5 text-[12px] text-text-1"
                value={pageSize}
                title="Linhas por página"
                onChange={(e) => {
                  if (blocked()) return;
                  setPage(0);
                  setPageSize(Number(e.target.value));
                }}
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {formatCount(n)} por página
                  </option>
                ))}
              </select>
              <button className="rounded p-1 hover:bg-bg-hover disabled:opacity-40" disabled={page === 0 || loading} onClick={() => !blocked() && setPage((p) => p - 1)} title="Página anterior">
                <ChevronLeft size={15} />
              </button>
              <span className="whitespace-nowrap">
                {rows.length ? `${formatCount(from)}–${formatCount(from + rows.length - 1)}` : "0"}
                {total != null ? ` de ${formatCount(total)}` : ""}
              </span>
              <button className="rounded p-1 hover:bg-bg-hover disabled:opacity-40" disabled={!data?.has_more || loading} onClick={() => !blocked() && setPage((p) => p + 1)} title="Próxima página">
                <ChevronRight size={15} />
              </button>
              {total == null && (
                <button className="rounded px-1.5 py-0.5 text-[11px] hover:bg-bg-hover" onClick={() => void load(true)} title="Contar as linhas (COUNT(*), pode demorar em tabelas grandes)">
                  <Hash size={12} className="inline" /> contar
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {tab === "data" && draft.length > 0 && (
        <div className="space-y-1 border-b border-border bg-bg-panel px-3 py-2 text-[12px]">
          {draft.map((f, i) => {
            const op = FILTER_OPS.find((o) => o.op === f.op);
            const upd = (p: Partial<DbFilter>) => setDraft((d) => d.map((x, k) => (k === i ? { ...x, ...p } : x)));
            return (
              <div key={i} className="flex items-center gap-1.5">
                <select className="rounded border border-border bg-bg-card px-1 py-1 text-text-1" value={f.column} onChange={(e) => upd({ column: e.target.value })}>
                  {cols.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <select className="rounded border border-border bg-bg-card px-1 py-1 text-text-1" value={f.op} onChange={(e) => upd({ op: e.target.value as DbFilter["op"] })}>
                  {FILTER_OPS.map((o) => (
                    <option key={o.op} value={o.op}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {op?.needsValue && (
                  <input
                    className="w-64 rounded border border-border bg-bg-card px-2 py-1 font-mono text-text-1 outline-none focus:border-accent"
                    value={f.value}
                    style={{ userSelect: "text" }}
                    onChange={(e) => upd({ value: e.target.value })}
                    onKeyDown={(e) => e.key === "Enter" && applyFilters()}
                  />
                )}
                <button className="rounded p-1 text-text-3 hover:bg-bg-hover hover:text-text-1" title="Remover filtro" onClick={() => setDraft((d) => d.filter((_, k) => k !== i))}>
                  <X size={13} />
                </button>
              </div>
            );
          })}
          <div className="flex items-center gap-2 pt-1">
            <button
              className="flex items-center gap-1 rounded px-2 py-1 text-text-2 hover:bg-bg-hover"
              onClick={() => setDraft((d) => [...d, { column: cols[0]?.name ?? "", op: "contains", value: "" }])}
            >
              <Plus size={13} /> Adicionar
            </button>
            <button className="rounded bg-accent px-3 py-1 font-semibold text-white hover:bg-accent-hover" onClick={applyFilters}>
              Aplicar
            </button>
            <button
              className="rounded px-2 py-1 text-text-2 hover:bg-bg-hover"
              onClick={() => {
                setDraft([]);
                if (filters.length) {
                  setPage(0);
                  setFilters([]);
                }
              }}
            >
              Limpar filtros
            </button>
            <span className="text-text-3">Todas as condições precisam valer (E). “contém” ignora maiúsculas no PostgreSQL.</span>
          </div>
        </div>
      )}

      {error && <div className="border-b border-status-err/40 bg-status-err/10 px-3 py-1.5 text-[12px] text-status-err">{error}</div>}

      <div className="min-h-0 flex-1">
        {tab === "data" ? (
          data?.columns ? (
            <DbResultGrid
              columns={data.columns}
              rows={rows}
              sort={sort}
              onSort={onSort}
              pkColumns={pk}
              editable={editable}
              changes={editable ? changes : undefined}
              onChanges={editable ? setChanges : undefined}
              duplicateSkip={dupSkip}
              onSelectRow={setSelRow}
              onSelectRows={editable ? setPickedRows : undefined}
              focusRow={focusRow}
              firstRowNumber={from}
              onNotice={onNotice}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-text-3">
              {loading ? <LoaderCircle size={18} className="animate-spin" /> : "Sem dados."}
            </div>
          )
        ) : (
          <div className="h-full overflow-auto p-3 text-[12px]" style={{ userSelect: "text" }}>
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-left text-text-2">
                  <th className="border-b border-border px-2 py-1">Coluna</th>
                  <th className="border-b border-border px-2 py-1">Tipo</th>
                  <th className="border-b border-border px-2 py-1">Nulo?</th>
                  <th className="border-b border-border px-2 py-1">Padrão</th>
                </tr>
              </thead>
              <tbody>
                {cols.map((c) => (
                  <tr key={c.name} className="hover:bg-bg-hover">
                    <td className="border-b border-border/50 px-2 py-1 text-text-1">
                      {c.pk && <KeyRound size={11} className="mr-1 inline text-status-warn" />}
                      {c.name}
                    </td>
                    <td className="border-b border-border/50 px-2 py-1 font-mono text-text-2">{c.type}</td>
                    <td className="border-b border-border/50 px-2 py-1 text-text-2">{c.nullable ? "sim" : "não"}</td>
                    <td className="border-b border-border/50 px-2 py-1 font-mono text-text-2">{c.default ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mb-1 mt-4 font-semibold text-text-1">Índices</div>
            {indexes.length === 0 ? (
              <div className="text-text-3">Nenhum índice.</div>
            ) : (
              <table className="w-full border-collapse">
                <tbody>
                  {indexes.map((ix) => (
                    <tr key={ix.name} className="hover:bg-bg-hover">
                      <td className="border-b border-border/50 px-2 py-1 text-text-1">{ix.name}</td>
                      <td className="border-b border-border/50 px-2 py-1 text-text-2">{ix.primary ? "chave primária" : ix.unique ? "único" : ""}</td>
                      <td className="border-b border-border/50 px-2 py-1 font-mono text-text-2">{(ix.columns ?? []).join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-border px-3 py-1 text-[11px] text-text-3">
        <span>{target.type === "view" ? "view" : "tabela"} {title}</span>
        {data && <span>{formatMs(data.elapsed_ms)}</span>}
        {data?.truncated_cells ? <span>{data.truncated_cells} células longas cortadas (duplo clique mostra o que veio)</span> : null}
        {readOnly && <span className="text-status-warn">somente leitura</span>}
      </div>
      {delOpen && data?.columns && (
        <DbDeleteDialog
          connName={connName}
          connColor={connColor}
          database={target.database}
          table={title}
          pk={[...pk]}
          columns={data.columns}
          rows={toDelete}
          busy={delBusy}
          error={delErr}
          onCancel={() => setDelOpen(false)}
          onConfirm={() => void doDelete()}
        />
      )}
    </div>
  );
}
