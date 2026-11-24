import { useEffect, useState, type ReactNode } from "react";
import { Cable, Loader2, Server, TerminalSquare } from "lucide-react";
import type { Connection } from "@/lib/connection";
import type { PaneInfo, ShellInfo } from "@/lib/types";
import { shellKind, type ShellKind } from "@/lib/agents";
import { paneLabel } from "@/lib/panes";
import { PANE_MIME, draggedPane, endDrag } from "@/lib/dnd";
import { isAgentTool, ToolIcon, toolInText } from "./ToolIcon";
import { KIND_LABEL, SHELL_ICON } from "./NewTerminalDialog";
import { cn } from "@/lib/utils";
import type { ToolKind } from "./SshScreen";

const COLUMNS: { kind: ShellKind; title: string }[] = [
  { kind: "other", title: "Shell" },
  { kind: "wsl", title: "Linux" },
  { kind: "powershell", title: "PowerShell" },
  { kind: "cmd", title: "Prompt" },
  { kind: "gitbash", title: "Git" },
  { kind: "ssh", title: "Remoto" },
];

interface Props {
  conn: Connection;
  shells: ShellInfo[] | null;
  panes: PaneInfo[] | null;
  readOnly: boolean;
  dragging: boolean;
  onDrop: (pane: number) => void;
  onOpen: (pane: number) => void;
  onSpawn: (shell: ShellInfo) => void;
  onOpenTools: (kind: ToolKind) => void;
}

/** Aba sem terminal: um quadro com as mesmas opções do botão de nova aba. */
export function EmptyTabBoard({ conn, shells, panes, readOnly, dragging, onDrop, onOpen, onSpawn, onOpenTools }: Props) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!readOnly && !shells) conn.requestShells();
  }, [conn, readOnly, shells]);

  const grouped = new Map<ShellKind, ShellInfo[]>();
  for (const s of shells ?? []) {
    const k = shellKind(s.id);
    grouped.set(k, [...(grouped.get(k) ?? []), s]);
  }
  const columns = COLUMNS.filter((c) => (grouped.get(c.kind) ?? []).length > 0);
  if (columns.length === 0 && !readOnly) columns.push({ kind: "other", title: "Shell" });

  const open = (s: ShellInfo) => {
    setBusy(s.id);
    onSpawn(s);
  };

  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4", over && "bg-accent-soft/30")}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(PANE_MIME)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const p = draggedPane(e);
        endDrag();
        if (p !== null) onDrop(p);
      }}
    >
      <div>
        <div className="text-[15px] font-semibold text-text-1">O que abrir nesta aba</div>
        <div className="text-[12px] text-text-3">As mesmas opções do botão de nova aba. Ou arraste um terminal para cá.</div>
      </div>
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
        {columns.map((c) => (
          <Column key={c.kind} title={c.title} count={(grouped.get(c.kind) ?? []).length}>
            {(grouped.get(c.kind) ?? []).map((s) => {
              const Icon = SHELL_ICON[shellKind(s.id)];
              return (
                <button
                  key={s.id}
                  className="flex items-center gap-2 rounded-lg bg-bg-card px-2.5 py-2 text-left hover:bg-bg-hover disabled:opacity-50"
                  disabled={readOnly || busy !== null}
                  onClick={() => open(s)}
                >
                  {busy === s.id ? <Loader2 size={15} className="shrink-0 animate-spin text-accent-text" /> : <Icon size={15} className="shrink-0 text-accent-text" />}
                  <span className="min-w-0 truncate text-[13px] text-text-1">{s.label}</span>
                </button>
              );
            })}
          </Column>
        ))}
        <Column title="Conectar" count={2}>
          <button className="flex items-center gap-2 rounded-lg bg-bg-card px-2.5 py-2 text-left hover:bg-bg-hover" onClick={() => onOpenTools("ssh")}>
            <Server size={15} className="shrink-0 text-accent-text" />
            <span className="text-[13px] text-text-1">SSH…</span>
          </button>
          <button className="flex items-center gap-2 rounded-lg bg-bg-card px-2.5 py-2 text-left hover:bg-bg-hover" onClick={() => onOpenTools("serial")}>
            <Cable size={15} className="shrink-0 text-accent-text" />
            <span className="text-[13px] text-text-1">Serial…</span>
          </button>
        </Column>
        {(panes ?? []).length > 0 && (
          <Column title="Já abertos" count={panes?.length ?? 0}>
            {(panes ?? []).map((p) => {
              const tool = isAgentTool(p.tool) ? p.tool : toolInText(paneLabel(p));
              return (
                <button
                  key={p.pane_id}
                  className="flex items-center gap-2 rounded-lg bg-bg-card px-2.5 py-2 text-left hover:bg-bg-hover"
                  onClick={() => onOpen(p.pane_id)}
                >
                  {isAgentTool(tool) ? <ToolIcon tool={tool} size={15} /> : <TerminalSquare size={15} className="shrink-0 text-text-3" />}
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] text-text-1">{paneLabel(p)}</span>
                    <span className="block truncate text-[10px] text-text-3">{p.kind_label || "terminal"}</span>
                  </span>
                </button>
              );
            })}
          </Column>
        )}
      </div>
      {dragging && <div className="text-center text-[12px] text-text-2">Solte o terminal aqui para abrir nesta aba</div>}
    </div>
  );
}

function Column({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="flex w-56 shrink-0 flex-col gap-1.5 rounded-lg bg-bg-panel/70 p-2">
      <div className="flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-text-3">
        {title}
        <span className="ml-auto font-normal">{count}</span>
      </div>
      {children}
    </section>
  );
}
