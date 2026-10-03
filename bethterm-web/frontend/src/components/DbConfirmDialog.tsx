import { useEffect, useRef, useState } from "react";
import { ShieldAlert, TriangleAlert } from "lucide-react";
import type { DbConfirmItem } from "@/lib/dbApi";
import { kindLabel } from "@/lib/dbFormat";
import { cn } from "@/lib/utils";

const TYPED_WORD = "CONFIRMAR";

/**
 * Confirmação antes de rodar instruções que alteram dados, estrutura ou a
 * sessão. Mostra cada instrução. Quando alguma é perigosa (DROP, TRUNCATE,
 * UPDATE/DELETE sem WHERE), pede para digitar CONFIRMAR. "Cancelar" tem o foco.
 */
export function DbConfirmDialog({
  connName,
  connColor,
  database,
  statements,
  total,
  danger,
  onConfirm,
  onCancel,
}: {
  connName: string;
  connColor?: string;
  database?: string;
  statements: DbConfirmItem[];
  total: number;
  danger: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [typed, setTyped] = useState("");
  useEffect(() => cancelRef.current?.focus(), []);
  const ok = !danger || typed.trim().toUpperCase() === TYPED_WORD;
  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/55 pt-[8vh]" onMouseDown={onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="Confirmar alteração no banco"
        className={cn(
          "flex max-h-[80vh] w-[min(760px,94vw)] flex-col rounded-lg border bg-bg-card p-4 text-[12px] text-text-1 shadow-2xl",
          danger ? "border-status-err/60" : "border-status-warn/60",
        )}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      >
        <div className="mb-2 flex items-center gap-2 text-[15px] font-semibold">
          {danger ? <TriangleAlert size={17} className="text-status-err" /> : <ShieldAlert size={17} className="text-status-warn" />}
          {danger ? "Atenção: alteração perigosa" : "Confirmar alteração no banco"}
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-1.5 text-text-2">
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
          <span>
            · {statements.length} de {total} instruç{total === 1 ? "ão" : "ões"} {statements.length === 1 ? "altera" : "alteram"} algo
          </span>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-auto">
          {statements.map((s) => (
            <div key={s.index} className={cn("rounded border p-2", s.danger ? "border-status-err/50 bg-status-err/5" : "border-border bg-bg-panel")}>
              <div className="mb-1 flex items-center gap-2 text-[11px]">
                <span className="text-text-3">#{s.index + 1}</span>
                <span className={cn("rounded px-1.5 py-0.5 font-semibold", s.danger ? "bg-status-err/20 text-status-err" : "bg-status-warn/20 text-status-warn")}>
                  {kindLabel(s.kind)}
                </span>
                {s.reason && <span className={s.danger ? "text-status-err" : "text-text-2"}>{s.reason}</span>}
              </div>
              <pre className="max-h-48 select-text overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] text-text-1" style={{ userSelect: "text" }}>
                {s.sql}
              </pre>
            </div>
          ))}
        </div>
        {danger && (
          <label className="mt-3 flex flex-col gap-1 text-text-2">
            <span>
              Para continuar, digite <b className="text-text-1">{TYPED_WORD}</b>:
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
          <button ref={cancelRef} className="rounded bg-bg-hover px-4 py-1.5 text-text-1 hover:bg-border" onClick={onCancel}>
            Cancelar
          </button>
          <button
            disabled={!ok}
            className={cn(
              "rounded px-4 py-1.5 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40",
              danger ? "bg-[#DC2626] hover:bg-[#B91C1C]" : "bg-accent hover:bg-accent-hover",
            )}
            onClick={onConfirm}
          >
            Executar mesmo assim
          </button>
        </div>
      </div>
    </div>
  );
}
