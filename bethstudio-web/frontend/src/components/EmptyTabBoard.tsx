import { useEffect, useState, type ReactNode } from "react";
import { Cable, Loader2, Server, TerminalSquare } from "lucide-react";
import type { Connection } from "@/lib/connection";
import type { PaneInfo, ShellInfo } from "@/lib/types";
import { shellKind, type ShellKind } from "@/lib/agents";
import { paneLabel } from "@/lib/panes";
import { PANE_MIME, draggedPane, endDrag } from "@/lib/dnd";
import { isAgentTool, ToolIcon, toolInText } from "./ToolIcon";
import { SHELL_ICON } from "./NewTerminalDialog";
import { cn } from "@/lib/utils";
import type { ToolKind } from "./SshScreen";

const COLUMNS_ALL: { kind: ShellKind; title: string }[] = [
  { kind: "other", title: "Shell" },
  { kind: "container", title: "Container" },
  { kind: "wsl", title: "Linux" },
  { kind: "powershell", title: "PowerShell" },
  { kind: "cmd", title: "Prompt" },
  { kind: "gitbash", title: "Git" },
  { kind: "ssh", title: "Remoto" },
];

const MAC_HIDE: ShellKind[] = ["wsl", "powershell", "cmd", "gitbash"];

function boardColumns(): { kind: ShellKind; title: string }[] {
  const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  return mac ? COLUMNS_ALL.filter((c) => !MAC_HIDE.includes(c.kind)) : COLUMNS_ALL.filter((c) => c.kind !== "container");
}

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
  useEffect(() => {
    if (!dragging) setOver(false);
  }, [dragging]);

  const grouped = new Map<ShellKind, ShellInfo[]>();
  for (const s of shells ?? []) {
    const k = shellKind(s.id);
    grouped.set(k, [...(grouped.get(k) ?? []), s]);
  }
  const columns = boardColumns().filter((c) => (grouped.get(c.kind) ?? []).length > 0);
  if (columns.length === 0 && !readOnly) columns.push({ kind: "other", title: "Shell" });

  const open = (s: ShellInfo) => {
    setBusy(s.id);
    onSpawn(s);
  };

  return (
    <div
      className={cn("relative flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4", over && "bg-accent-soft/20")}
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
      {(over || dragging) && (
        <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent/70 bg-accent/[0.08] shadow-[inset_0_0_0_1px_rgb(var(--bt-accent)/0.2)]">
          <div className="bt-drop-ghost bt-drop-ghost-on flex flex-col items-center gap-2 px-8 py-6">
            <span className="bt-drop-ghost__label">Solte para abrir nesta guia</span>
          </div>
        </div>
      )}
      <div>
        <div className="bt-settings-page__title text-[22px]">O que abrir nesta aba</div>
        <div className="bt-settings-page__sub">As mesmas opções do botão de nova aba. Ou arraste um terminal para cá.</div>
      </div>
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
        {columns.map((c) => (
          <Column key={c.kind} title={c.title} count={(grouped.get(c.kind) ?? []).length}>
            {(grouped.get(c.kind) ?? []).map((s) => {
              const Icon = SHELL_ICON[shellKind(s.id)];
              return (
                <button
                  key={s.id}
                  type="button"
                  className="bt-settings-choice w-full disabled:opacity-50"
                  disabled={readOnly || busy !== null}
                  onClick={() => open(s)}
                >
                  <span className="bt-settings-choice__icon flex items-center gap-2">
                    {busy === s.id ? <Loader2 size={15} className="animate-spin" /> : <Icon size={15} />}
                    <span className="bt-settings-choice__title truncate">{s.label}</span>
                  </span>
                </button>
              );
            })}
          </Column>
        ))}
        <Column title="Conectar" count={2}>
          <button type="button" className="bt-settings-choice w-full" onClick={() => onOpenTools("ssh")}>
            <span className="bt-settings-choice__icon flex items-center gap-2">
              <Server size={15} />
              <span className="bt-settings-choice__title">SSH…</span>
            </span>
          </button>
          <button type="button" className="bt-settings-choice w-full" onClick={() => onOpenTools("serial")}>
            <span className="bt-settings-choice__icon flex items-center gap-2">
              <Cable size={15} />
              <span className="bt-settings-choice__title">Serial…</span>
            </span>
          </button>
        </Column>
        {(panes ?? []).length > 0 && (
          <Column title="Já abertos" count={panes?.length ?? 0}>
            {(panes ?? []).map((p) => {
              const tool = isAgentTool(p.tool) ? p.tool : toolInText(paneLabel(p));
              return (
                <button key={p.pane_id} type="button" className="bt-settings-choice w-full" onClick={() => onOpen(p.pane_id)}>
                  <span className="bt-settings-choice__icon flex items-center gap-2">
                    {isAgentTool(tool) ? <ToolIcon tool={tool} size={15} /> : <TerminalSquare size={15} />}
                    <span className="min-w-0">
                      <span className="bt-settings-choice__title block truncate">{paneLabel(p)}</span>
                      <span className="bt-settings-choice__sub block truncate">{p.kind_label || "terminal"}</span>
                    </span>
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
    <section className="bt-settings-panel flex w-56 shrink-0 flex-col gap-1.5 !p-2">
      <div className="bt-settings-label flex items-center gap-1.5 !mx-1 !mb-0">
        {title}
        <span className="ml-auto font-normal normal-case tracking-normal">{count}</span>
      </div>
      {children}
    </section>
  );
}
