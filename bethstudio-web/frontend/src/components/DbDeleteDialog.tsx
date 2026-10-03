import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Trash2 } from "lucide-react";
import type { DbCell, DbResultColumn } from "@/lib/dbApi";
import { cellDisplay } from "@/lib/dbFormat";
import { cn } from "@/lib/utils";

const PREVIEW_ROWS = 8;
const PREVIEW_COLS = 5;
/** a partir daqui, tem que digitar a quantidade para confirmar */
const TYPE_COUNT_FROM = 20;

/**
 * Confirmação antes de apagar linhas selecionadas na grade. Mostra a tabela,
 * a coluna que identifica cada linha (a chave) e uma amostra do que vai sumir.
 * "Cancelar" tem o foco; com muitas linhas pede para digitar a quantidade.
 */
export function DbDeleteDialog({
  connName,
  connColor,
  database,
  table,
  pk,
  columns,
  rows,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  connName: string;
  connColor?: string;
  database?: string;
  table: string;
  pk: string[];
  columns: DbResultColumn[];
  rows: DbCell[][];
  busy: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [typed, setTyped] = useState("");
  useEffect(() => cancelRef.current?.focus(), []);
  const n = rows.length;
  const needTyped = n >= TYPE_COUNT_FROM;
  const ok = !busy && (!needTyped || typed.trim() === String(n));
  // chave primeiro, depois as primeiras colunas, para a pessoa reconhecer as linhas
  const order = [
    ...columns.map((c, i) => ({ c, i })).filter((x) => pk.includes(x.c.name)),
    ...columns.map((c, i) => ({ c, i })).filter((x) => !pk.includes(x.c.name)),
  ].slice(0, PREVIEW_COLS);
  const label = n === 1 ? "1 linha" : `${n.toLocaleString("pt-BR")} linhas`;
  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/55 pt-[8vh]" onMouseDown={busy ? undefined : onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="Confirmar exclusão de linhas"
        className="flex max-h-[80vh] w-[min(720px,94vw)] flex-col rounded-lg border border-status-err/60 bg-bg-card p-4 text-[12px] text-text-1 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && !busy && onCancel()}
      >
        <div className="mb-2 flex items-center gap-2 text-[15px] font-semibold">
          <Trash2 size={17} className="text-status-err" />
          Apagar {label} de {table}?
        </div>
        <div className="mb-2 flex flex-wrap items-center gap-1.5 text-text-2">
          Conexão
          <span className="inline-flex items-center gap-1 rounded bg-bg-panel px-1.5 py-0.5 font-semibold text-text-1">
            {connColor && <span className="h-2 w-2 rounded-full" style={{ background: connColor }} />}
            {connName}
          </span>
          {database && (
            <>
              banco <span className="rounded bg-bg-panel px-1.5 py-0.5 font-mono text-text-1">{database}</span>
            </>
          )}
        </div>
        <div className="mb-2 text-text-2">
          Cada linha é identificada por <b className="font-mono text-text-1">{pk.join(" + ")}</b>. Tudo acontece numa transação: se alguma linha falhar, nada é apagado. Isto não pode ser desfeito.
        </div>
        <div className="min-h-0 flex-1 overflow-auto rounded border border-border">
          <table className="w-full border-collapse font-mono text-[11px]">
            <thead>
              <tr className="bg-bg-panel text-left text-text-2">
                {order.map(({ c }) => (
                  <th key={c.name} className="whitespace-nowrap border-b border-border px-2 py-1 font-semibold">
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, PREVIEW_ROWS).map((r, k) => (
                <tr key={k} className={k % 2 ? "bg-bg-panel/40" : ""}>
                  {order.map(({ c, i }) => (
                    <td key={c.name} className={cn("max-w-[220px] truncate px-2 py-0.5", pk.includes(c.name) ? "text-text-1" : "text-text-2")}>
                      {cellDisplay(r[i] ?? null, 60)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {n > PREVIEW_ROWS && <div className="mt-1 text-text-3">… e mais {(n - PREVIEW_ROWS).toLocaleString("pt-BR")}</div>}
        {error && <div className="mt-2 rounded border border-status-err/50 bg-status-err/10 p-2 text-status-err">{error}</div>}
        {needTyped && (
          <label className="mt-3 flex flex-col gap-1 text-text-2">
            <span>
              Para continuar, digite a quantidade (<b className="text-text-1">{n}</b>):
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="rounded border border-border bg-bg-panel px-2 py-1.5 font-mono text-text-1 outline-none focus:border-accent"
              style={{ userSelect: "text" }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && ok) onConfirm();
              }}
            />
          </label>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button ref={cancelRef} disabled={busy} className="rounded bg-bg-hover px-4 py-1.5 text-text-1 hover:bg-border disabled:opacity-50" onClick={onCancel}>
            Cancelar
          </button>
          <button
            disabled={!ok}
            className="flex items-center gap-1.5 rounded bg-[#DC2626] px-4 py-1.5 font-semibold text-white hover:bg-[#B91C1C] disabled:cursor-not-allowed disabled:opacity-40"
            onClick={onConfirm}
          >
            {busy ? <LoaderCircle size={13} className="animate-spin" /> : <Trash2 size={13} />} Apagar {label}
          </button>
        </div>
      </div>
    </div>
  );
}
