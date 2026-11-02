import { useEffect, useRef } from "react";
import { AlertTriangle, Power, RotateCw } from "lucide-react";
import type { Connection } from "@/lib/connection";
import type { PaneInfo } from "@/lib/types";
import type { AgentInfo } from "@/lib/agents";
import { killConfirmed } from "@/lib/killFlow";
import { paneLabel, shortCwd } from "@/lib/panes";
import { KindIcon } from "./KindIcon";

/**
 * "Encerrar / Matar / Reiniciar este terminal?" — Cancelar tem o foco; so' o
 * botao vermelho encerra. O host encerra o shell e tudo o que ele abriu (patch 0203).
 */
export type KillMode = "encerrar" | "matar" | "reiniciar";

const TEXT: Record<KillMode, { title: string; button: string; body: string }> = {
  encerrar: {
    title: "Encerrar este terminal?",
    button: "Encerrar",
    body: "O terminal e tudo o que ele abriu (agentes, servidores MCP, WSL) são encerrados no Beth Studio. Fechar a aba ou a visualização não faz isso — os terminais continuam rodando.",
  },
  matar: {
    title: "Matar este terminal?",
    button: "Matar",
    body: "O terminal e tudo o que ele abriu (agentes, servidores MCP, WSL) são encerrados no Beth Studio, e ele sai da aba. Se for o único da aba, a aba fecha.",
  },
  reiniciar: {
    title: "Reiniciar este terminal?",
    button: "Reiniciar",
    body: "Abre um shell novo do mesmo tipo, na mesma pasta e no mesmo lugar da aba. Depois encerra este e tudo o que ele abriu. Se o novo não abrir, este continua como está.",
  },
};

export function KillDialog({
  conn,
  pane,
  info,
  agent,
  mode = "encerrar",
  onKilled,
  onRestart,
  onClose,
}: {
  conn: Connection;
  pane: number;
  info: PaneInfo | undefined;
  agent: AgentInfo | undefined;
  mode?: KillMode;
  /** "matar": depois do kill (tira da aba) */
  onKilled?: () => void;
  /** "reiniciar": abre o novo e chama `end` para encerrar o antigo */
  onRestart?: (end: (pane: number) => boolean) => void;
  onClose: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  const isAgent = !!info?.agent || !!agent;
  const t = TEXT[mode];
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
          {mode === "reiniciar" ? <RotateCw size={16} className="text-status-err" /> : <Power size={16} className="text-status-err" />} {t.title}
        </div>
        <div className="mb-3 rounded bg-bg-panel p-2">
          <div className="flex items-center gap-1.5 text-text-1">
            {info && <KindIcon pane={info} />}
            <span className="truncate">{info ? paneLabel(info) : `Terminal ${pane}`}</span>
          </div>
          {info?.cwd && <div className="truncate font-mono text-[11px] text-text-2">{shortCwd(info.cwd, 6)}</div>}
          {info?.kind_label && <div className="text-[11px] text-text-3">{info.kind_label}</div>}
        </div>
        <p className="mb-2 text-[12px] text-text-2">{t.body}</p>
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
              if (mode === "reiniciar") onRestart?.((p) => killConfirmed(conn, p));
              else {
                killConfirmed(conn, pane);
                onKilled?.();
              }
              onClose();
            }}
          >
            {t.button}
          </button>
        </div>
      </div>
    </div>
  );
}
