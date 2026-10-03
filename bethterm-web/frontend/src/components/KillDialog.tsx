import { useEffect, useRef } from "react";
import { AlertTriangle, Power } from "lucide-react";
import type { Connection } from "@/lib/connection";
import type { PaneInfo } from "@/lib/types";
import type { AgentInfo } from "@/lib/agents";
import { killConfirmed } from "@/lib/killFlow";
import { paneLabel, shortCwd } from "@/lib/panes";
import { KindIcon } from "./KindIcon";

/** "Encerrar este terminal?" — Cancelar tem o foco; so' "Encerrar" manda kill. */
export function KillDialog({
  conn,
  pane,
  info,
  agent,
  onClose,
}: {
  conn: Connection;
  pane: number;
  info: PaneInfo | undefined;
  agent: AgentInfo | undefined;
  onClose: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  const isAgent = !!info?.agent || !!agent;
  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/50 pt-[14vh]" onMouseDown={onClose}>
      <div
        className="w-[min(480px,92vw)] rounded-lg border border-status-err/50 bg-bg-card p-4 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        role="alertdialog"
        aria-modal="true"
      >
        <div className="mb-2 flex items-center gap-2 text-[15px] font-semibold text-text-1">
          <Power size={16} className="text-status-err" /> Encerrar este terminal?
        </div>
        <div className="mb-3 rounded bg-bg-panel p-2">
          <div className="flex items-center gap-1.5 text-text-1">
            {info && <KindIcon pane={info} />}
            <span className="truncate">{info ? paneLabel(info) : `Terminal ${pane}`}</span>
          </div>
          {info?.cwd && <div className="truncate font-mono text-[11px] text-text-2">{shortCwd(info.cwd, 6)}</div>}
          {info?.kind_label && <div className="text-[11px] text-text-3">{info.kind_label}</div>}
        </div>
        <p className="mb-2 text-[12px] text-text-2">
          O processo é encerrado no BethTerm (também some da GUI). Fechar a aba ou a visualização não faz isso — os terminais continuam
          rodando.
        </p>
        {(isAgent || agent) && (
          <div className="mb-3 flex items-start gap-2 rounded border border-status-warn/50 bg-status-warn/10 p-2 text-[12px] text-text-1">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-status-warn" />
            <span>
              {agent ? "Um agente neste terminal está aguardando sua resposta." : "Este terminal parece ter um agente de IA rodando."} O
              trabalho em andamento será interrompido.
            </span>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button ref={cancelRef} className="rounded bg-bg-hover px-4 py-1.5 text-text-1 hover:bg-border" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="rounded bg-[#DC2626] px-4 py-1.5 font-semibold text-white hover:bg-[#B91C1C]"
            onClick={() => {
              killConfirmed(conn, pane);
              onClose();
            }}
          >
            Encerrar
          </button>
        </div>
      </div>
    </div>
  );
}
