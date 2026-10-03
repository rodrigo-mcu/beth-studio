import { useEffect, useRef, useState } from "react";
import { Copy, CornerDownLeft, LoaderCircle, Search, Trash2, X } from "lucide-react";
import { dbApi, type DbApiClient, type DbConnView, type DbHistoryEntry } from "@/lib/dbApi";
import { copyText } from "@/lib/clipboard";
import { formatCount, formatMs } from "@/lib/dbFormat";
import { highlightPieces, oneLine, searchTerms } from "@/lib/dbHistory";
import { noteWhen } from "@/lib/notes";
import { cn } from "@/lib/utils";

const PAGE = 200;

/**
 * Histórico geral: tudo que foi executado no editor, em qualquer conexão e
 * banco, mais recente primeiro, com busca (todos os termos, no SQL, no nome da
 * conexão ou no banco). Clicar numa linha abre o SQL na conexão e no banco em
 * que rodou; "Só o SQL" cola no editor atual sem trocar de conexão.
 */
export function DbHistoryDialog({
  conn,
  connections,
  currentConnId,
  onUse,
  onUseSqlOnly,
  onNotice,
  onClose,
}: {
  conn: DbApiClient;
  connections: DbConnView[];
  currentConnId: string;
  /** abre o SQL na conexão/banco originais */
  onUse: (e: DbHistoryEntry) => void;
  /** cola só o SQL no editor atual */
  onUseSqlOnly: (e: DbHistoryEntry) => void;
  onNotice: (m: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [connId, setConnId] = useState("");
  const [failed, setFailed] = useState(false);
  const [items, setItems] = useState<DbHistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [askClear, setAskClear] = useState(false);
  const seq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const colorOf = (id: string) => connections.find((c) => c.id === id)?.color;
  const exists = (id: string) => connections.some((c) => c.id === id);
  const terms = searchTerms(q);

  useEffect(() => inputRef.current?.focus(), []);

  // busca 250 ms depois da última tecla; resposta velha não sobrescreve a nova
  useEffect(() => {
    const my = ++seq.current;
    setLoading(true);
    const t = window.setTimeout(() => {
      dbApi
        .history(conn, { q, connId, failed, limit: PAGE, offset: 0 })
        .then((r) => {
          if (seq.current !== my) return;
          setItems(r.items);
          setTotal(r.total);
          setError("");
        })
        .catch((e: unknown) => seq.current === my && setError(e instanceof Error ? e.message : String(e)))
        .finally(() => seq.current === my && setLoading(false));
    }, 250);
    return () => window.clearTimeout(t);
  }, [conn, q, connId, failed]);

  const more = () => {
    const my = seq.current;
    setLoading(true);
    dbApi
      .history(conn, { q, connId, failed, limit: PAGE, offset: items.length })
      .then((r) => {
        if (seq.current !== my) return;
        setItems((cur) => [...cur, ...r.items]);
        setTotal(r.total);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };
  const remove = (id: string) => {
    setItems((cur) => cur.filter((x) => x.id !== id));
    setTotal((n) => Math.max(0, n - 1));
    void dbApi.deleteHistory(conn, id).catch((e: Error) => onNotice(e.message));
  };
  const clearAll = () => {
    setAskClear(false);
    void dbApi
      .clearHistory(conn)
      .then(() => {
        setItems([]);
        setTotal(0);
        onNotice("Histórico apagado");
      })
      .catch((e: Error) => onNotice(e.message));
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/55 pt-[6vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Histórico geral de consultas"
        className="flex max-h-[84vh] w-[min(980px,95vw)] flex-col rounded-lg border border-border-strong bg-bg-card text-[12px] text-text-1 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-[14px] font-semibold">Histórico geral de consultas</span>
          <span className="text-text-3">
            {loading && items.length === 0 ? "" : `${formatCount(total)} ${total === 1 ? "execução" : "execuções"}`}
          </span>
          <div className="ml-auto flex items-center gap-1">
            {askClear ? (
              <>
                <span className="text-text-2">Apagar o histórico de todas as conexões?</span>
                <button className="rounded bg-[#DC2626] px-2 py-1 font-semibold text-white hover:bg-[#B91C1C]" onClick={clearAll}>
                  Apagar tudo
                </button>
                <button className="rounded px-2 py-1 ring-1 ring-border hover:bg-bg-hover" onClick={() => setAskClear(false)}>
                  Não
                </button>
              </>
            ) : (
              <button className="rounded px-2 py-1 text-text-2 hover:bg-bg-hover hover:text-status-err" onClick={() => setAskClear(true)} title="Apagar todo o histórico">
                Limpar tudo
              </button>
            )}
            <button className="rounded p-1 text-text-2 hover:bg-bg-hover" title="Fechar (Esc)" onClick={onClose}>
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <div className="relative min-w-[220px] flex-1">
            <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-3" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar no SQL, na conexão ou no banco (vários termos = todos)"
              className="h-8 w-full rounded border border-border bg-bg-panel pl-7 pr-2 text-text-1 outline-none focus:border-accent"
              style={{ userSelect: "text" }}
            />
          </div>
          <select
            value={connId}
            onChange={(e) => setConnId(e.target.value)}
            className="h-8 max-w-[220px] rounded border border-border bg-bg-panel px-1.5 text-text-1"
            title="Filtrar por conexão"
          >
            <option value="">Todas as conexões</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-text-2">
            <input type="checkbox" checked={failed} onChange={(e) => setFailed(e.target.checked)} /> só as que deram erro
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {error && <div className="p-3 text-status-err">{error}</div>}
          {!error && !loading && items.length === 0 && (
            <div className="p-6 text-center text-text-3">
              {q || connId || failed ? "Nada encontrado com esse filtro." : "Nenhuma consulta executada ainda. Tudo o que você executar passa a aparecer aqui."}
            </div>
          )}
          {items.map((e) => (
            <div
              key={e.id}
              className="group relative cursor-pointer border-b border-border/60 px-3 py-1.5 hover:bg-bg-hover"
              title={exists(e.connId) ? "Abrir este SQL na conexão e no banco em que rodou" : "A conexão original não existe mais; vai colar só o SQL"}
              onClick={() => (exists(e.connId) ? onUse(e) : onUseSqlOnly(e))}
            >
              <div className="mb-0.5 flex flex-wrap items-center gap-2 text-[11px] text-text-2">
                <span className="font-mono text-text-3">{noteWhen(e.at)}</span>
                <span className="inline-flex items-center gap-1 rounded bg-bg-panel px-1.5 py-0.5 text-text-1">
                  {colorOf(e.connId) && <span className="h-2 w-2 rounded-full" style={{ background: colorOf(e.connId) }} />}
                  {e.connName || "(conexão removida)"}
                  {e.connId === currentConnId && <span className="text-text-3">· atual</span>}
                </span>
                {e.database && <span className="rounded bg-bg-panel px-1.5 py-0.5 font-mono">{e.database}</span>}
                {e.error ? (
                  <span className="rounded bg-status-err/15 px-1.5 py-0.5 text-status-err" title={e.error}>
                    erro
                  </span>
                ) : (
                  <span className="text-text-3">{e.rows ? `${formatCount(e.rows)} linhas · ` : ""}{formatMs(e.ms)}</span>
                )}
              </div>
              <div className={cn("line-clamp-2 break-all font-mono text-[12px]", e.error ? "text-text-2" : "text-text-1")} title={e.sql}>
                {highlightPieces(oneLine(e.sql), terms).map((p, i) =>
                  p.hit ? (
                    <mark key={i} className="rounded bg-accent/30 px-0.5 text-text-1">
                      {p.text}
                    </mark>
                  ) : (
                    <span key={i}>{p.text}</span>
                  ),
                )}
              </div>
              {e.error && <div className="mt-0.5 truncate text-[11px] text-status-err">{e.error}</div>}
              <div className="absolute right-2 top-1.5 hidden items-center gap-0.5 rounded bg-bg-card p-0.5 shadow ring-1 ring-border group-hover:flex" onClick={(ev) => ev.stopPropagation()}>
                <button className="flex items-center gap-1 rounded px-1.5 py-0.5 text-text-2 hover:bg-bg-hover hover:text-text-1" title="Colar só o SQL no editor atual, sem trocar de conexão" onClick={() => onUseSqlOnly(e)}>
                  <CornerDownLeft size={12} /> Só o SQL
                </button>
                <button
                  className="rounded p-1 text-text-2 hover:bg-bg-hover hover:text-text-1"
                  title="Copiar o SQL"
                  onClick={() => void copyText(e.sql).then((ok) => onNotice(ok ? "SQL copiado" : "não foi possível copiar"))}
                >
                  <Copy size={12} />
                </button>
                <button className="rounded p-1 text-text-2 hover:bg-bg-hover hover:text-status-err" title="Tirar do histórico" onClick={() => remove(e.id)}>
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex items-center gap-1 p-3 text-text-3">
              <LoaderCircle size={13} className="animate-spin" /> buscando…
            </div>
          )}
          {!loading && items.length < total && (
            <div className="p-2 text-center">
              <button className="rounded bg-bg-hover px-3 py-1 hover:bg-border" onClick={more}>
                Mostrar mais ({formatCount(total - items.length)} restantes)
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
