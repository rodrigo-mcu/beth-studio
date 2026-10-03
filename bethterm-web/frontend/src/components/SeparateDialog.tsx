import { useEffect, useRef, useState } from "react";
import { SplitSquareHorizontal } from "lucide-react";
import type { Connection } from "@/lib/connection";
import type { PaneInfo } from "@/lib/types";
import { paneLabel } from "@/lib/panes";
import { setPane } from "@/lib/appearance";

/** "Separar no BethTerm": o pane sai do split do host (nada e' encerrado). */
export function SeparateDialog({
  conn,
  pane,
  info,
  onClose,
  onDone,
}: {
  conn: Connection;
  pane: number;
  info: PaneInfo | undefined;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/50 pt-[14vh]" onMouseDown={onClose}>
      <div
        className="w-[min(480px,92vw)] rounded-lg border border-border-strong bg-bg-card p-4 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        role="dialog"
        aria-modal="true"
      >
        <div className="mb-2 flex items-center gap-2 text-[15px] font-semibold text-text-1">
          <SplitSquareHorizontal size={16} className="text-accent-text" /> Separar no BethTerm?
        </div>
        <p className="mb-2 text-[13px] text-text-1">{info ? paneLabel(info) : `Terminal ${pane}`}</p>
        <p className="mb-3 text-[12px] text-text-2">
          Na GUI, este terminal sai do split e vira uma aba separada na mesma janela. Nada é encerrado. Depois disso o web pode ajustar o tamanho
          dele à janela.
        </p>
        {error && <div className="mb-2 rounded bg-status-err/10 p-2 text-[12px] text-status-err">{error}</div>}
        <div className="flex justify-end gap-2">
          <button ref={cancelRef} className="rounded bg-bg-hover px-4 py-1.5 text-text-1 hover:bg-border" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="rounded bg-accent px-4 py-1.5 font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              conn
                .separate(pane)
                .then(() => setPane(conn, pane, { size_mode: "fit" }))
                .then(() => {
                  onDone("Terminal separado no BethTerm — ajustando à janela");
                  onClose();
                })
                .catch((e: Error) => {
                  setBusy(false);
                  setError(e.message);
                });
            }}
          >
            Separar
          </button>
        </div>
      </div>
    </div>
  );
}
