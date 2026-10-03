import { isRemote } from "@/lib/remote";
import { FolderBrowser } from "./FolderBrowser";
import { useEffect, useState } from "react";
import { AppWindow, Cable, FileText, FolderOpen, Globe, Loader2, Server, SquareTerminal, Terminal, TerminalSquare, X } from "lucide-react";
import type { Connection } from "@/lib/connection";
import type { PaneInfo, ShellInfo } from "@/lib/types";
import { cwdFromPickedFolder, explorerStart, shellKind, spawnCwd, type ShellKind } from "@/lib/agents";
import { paneLabel } from "@/lib/panes";
import { cn } from "@/lib/utils";
import type { ToolKind } from "./SshScreen";

export const SHELL_ICON: Record<ShellKind, typeof Terminal> = {
  powershell: TerminalSquare,
  cmd: SquareTerminal,
  wsl: Terminal,
  gitbash: Terminal,
  ssh: Globe,
  log: FileText,
  other: Terminal,
};

const KIND_LABEL: Record<ShellKind, string> = {
  powershell: "PowerShell",
  cmd: "Prompt de comando",
  wsl: "WSL / Linux",
  gitbash: "Git Bash",
  ssh: "Remoto",
  log: "Log",
  other: "Terminal",
};

interface Props {
  conn: Connection;
  shells: ShellInfo[] | null;
  /** terminal em foco (pasta inicial e janela do host) */
  focused: PaneInfo | undefined;
  readOnly: boolean;
  onEmptyTab: () => void;
  /** cria a aba do web com o pane novo */
  onCreated: (pane: number, tabName: string) => void;
  /** abre a tela SSH / Serial (escolher host ou porta e conectar) */
  onOpenTools: (kind: ToolKind) => void;
  onClose: () => void;
}

/** "Novo terminal": escolhe o shell e cria o terminal no host (patch 0176). */
export function NewTerminalDialog({ conn, shells, focused, readOnly, onEmptyTab, onCreated, onOpenTools, onClose }: Props) {
  const [shell, setShell] = useState<ShellInfo | null>(null);
  const [cwd, setCwd] = useState("");
  const [cwdTouched, setCwdTouched] = useState(false);
  const [where, setWhere] = useState<"focused" | "new">(focused ? "focused" : "new");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [inPage, setInPage] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!readOnly) conn.requestShells();
  }, [conn, readOnly]);

  const pick = (s: ShellInfo) => {
    setShell(s);
    if (!nameTouched) setName(s.label);
    if (!cwdTouched) setCwd(focused ? spawnCwd(focused.cwd, s.id) : "");
  };

  const browse = () => {
    if (!shell || picking) return;
    // Studio remoto: o "Procurar" do Windows abriria no PC; usa o navegador da página.
    if (isRemote()) {
      setInPage(true);
      return;
    }
    setPicking(true);
    setError(null);
    const initial = explorerStart(cwd);
    const shellId = shell.id;
    conn
      .api<{ picked: boolean; path?: string }>("/api/pick-folder", initial ? { initial } : {})
      .then((r) => {
        if (r.picked && r.path) {
          setCwd(cwdFromPickedFolder(r.path, shellId));
          setCwdTouched(true);
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setPicking(false));
  };

  const create = () => {
    if (!shell) return;
    setBusy(true);
    setError(null);
    conn
      .spawn({ shell_id: shell.id, window_id: where === "focused" && focused ? focused.window_id : undefined, cwd: cwd.trim() || undefined })
      .then((ev) => {
        // So' o nome DIGITADO vira nome da aba; senao a aba acompanha o terminal.
        onCreated(ev.pane_id, nameTouched && name.trim() !== shell.label ? name.trim() : "");
        onClose();
      })
      .catch((e: Error) => {
        setBusy(false);
        setError(e.message);
      });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[8vh]" onMouseDown={onClose}>
      <div
        className="flex max-h-[84vh] w-[min(560px,94vw)] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-card shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <TerminalSquare size={16} className="text-accent-text" />
          <div className="flex-1 text-[15px] font-semibold text-text-1">Nova aba</div>
          <button className="rounded p-1 text-text-2 hover:bg-bg-hover hover:text-text-1" title="Fechar" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {readOnly ? (
            <div className="text-text-2">Modo somente leitura: criar terminais está desligado.</div>
          ) : (
            <>
              <div>
                <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-text-2">Novo terminal no Beth Studio</div>
                {!shells && (
                  <div className="flex items-center gap-2 py-2 text-text-2">
                    <Loader2 size={14} className="animate-spin" /> Buscando tipos de terminal…
                  </div>
                )}
                <div className="grid grid-cols-2 gap-1.5">
                  {(shells ?? []).map((s) => {
                    const k = shellKind(s.id);
                    const Icon = SHELL_ICON[k];
                    return (
                      <button
                        key={s.id}
                        className={cn(
                          "flex items-center gap-2 rounded-md border px-2.5 py-2 text-left",
                          shell?.id === s.id ? "border-accent bg-accent-soft" : "border-border bg-bg-panel hover:bg-bg-hover",
                        )}
                        onClick={() => pick(s)}
                        title={s.id}
                      >
                        <Icon size={16} className="shrink-0 text-accent-text" />
                        <span className="min-w-0">
                          <span className="block truncate text-text-1">{s.label}</span>
                          <span className="block truncate text-[10px] text-text-3">{KIND_LABEL[k]}</span>
                        </span>
                      </button>
                    );
                  })}
                  <button
                    className="flex items-center gap-2 rounded-md border border-border bg-bg-panel px-2.5 py-2 text-left hover:bg-bg-hover"
                    onClick={() => {
                      onClose();
                      onOpenTools("ssh");
                    }}
                    title="Escolher um host SSH salvo e conectar"
                  >
                    <Server size={16} className="shrink-0 text-accent-text" />
                    <span className="min-w-0">
                      <span className="block truncate text-text-1">SSH…</span>
                      <span className="block truncate text-[10px] text-text-3">Host remoto / SFTP</span>
                    </span>
                  </button>
                  <button
                    className="flex items-center gap-2 rounded-md border border-border bg-bg-panel px-2.5 py-2 text-left hover:bg-bg-hover"
                    onClick={() => {
                      onClose();
                      onOpenTools("serial");
                    }}
                    title="Escolher uma porta serial salva e conectar"
                  >
                    <Cable size={16} className="shrink-0 text-accent-text" />
                    <span className="min-w-0">
                      <span className="block truncate text-text-1">Serial…</span>
                      <span className="block truncate text-[10px] text-text-3">Porta COM</span>
                    </span>
                  </button>
                </div>
              </div>

              {shell && (
                <>
                  <div>
                    <span className="mb-1 flex items-center gap-1.5 text-[12px] text-text-2">
                      <FolderOpen size={13} /> Pasta inicial (opcional)
                    </span>
                    <div className="flex gap-1.5">
                      <input
                        value={cwd}
                        maxLength={1024}
                        onChange={(e) => {
                          setCwd(e.target.value);
                          setCwdTouched(true);
                        }}
                        placeholder={shellKind(shell.id) === "wsl" ? "/home/… ou /mnt/c/…" : "C:\\…"}
                        className="h-8 min-w-0 flex-1 rounded border border-border bg-bg-term px-2 font-mono text-[12px] text-text-1 outline-none focus:border-accent"
                      />
                      <button
                        type="button"
                        className="flex h-8 shrink-0 items-center gap-1 rounded border border-border bg-bg-panel px-2.5 text-[12px] text-text-1 hover:bg-bg-hover disabled:opacity-50"
                        title="Escolher a pasta"
                        disabled={picking}
                        onClick={browse}
                      >
                        {picking ? <Loader2 size={13} className="animate-spin" /> : <FolderOpen size={13} />}
                        Procurar…
                      </button>
                    </div>
                  </div>
                  <div>
                    <div className="mb-1 flex items-center gap-1.5 text-[12px] text-text-2">
                      <AppWindow size={13} /> Onde abrir no Beth Studio
                    </div>
                    <div className="flex flex-col gap-1">
                      <Radio
                        checked={where === "focused"}
                        disabled={!focused}
                        onClick={() => setWhere("focused")}
                        label="Como nova aba da janela do terminal em foco"
                        hint={focused ? `janela de “${paneLabel(focused)}”` : "nenhum terminal em foco"}
                      />
                      <Radio checked={where === "new"} onClick={() => setWhere("new")} label="Em janela nova do Beth Studio" hint="a GUI também mostra essa janela" />
                    </div>
                  </div>
                  <label className="block">
                    <span className="mb-1 block text-[12px] text-text-2">Nome da aba no web</span>
                    <input
                      value={name}
                      maxLength={60}
                      onChange={(e) => {
                        setName(e.target.value);
                        setNameTouched(true);
                      }}
                      className="h-8 w-full rounded border border-border bg-bg-term px-2 text-text-1 outline-none focus:border-accent"
                    />
                  </label>
                </>
              )}
              {error && <div className="rounded bg-status-err/10 px-2 py-1.5 text-[12px] text-status-err">Não foi possível criar: {error}</div>}
            </>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-border p-3">
          <button
            className="rounded bg-bg-hover px-3 py-1.5 text-text-1 hover:bg-border"
            onClick={() => {
              onEmptyTab();
              onClose();
            }}
            title="Cria uma aba do web sem terminal (arraste terminais para ela)"
          >
            Aba vazia
          </button>
          <div className="flex-1" />
          <button className="rounded px-3 py-1.5 text-text-2 hover:bg-bg-hover hover:text-text-1" onClick={onClose}>
            Cancelar
          </button>
          {!readOnly && (
            <button
              className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-white hover:bg-accent-hover disabled:opacity-50"
              disabled={!shell || busy}
              onClick={create}
            >
              {busy && <Loader2 size={13} className="animate-spin" />}
              Criar terminal
            </button>
          )}
        </div>
      </div>
      {inPage && shell && (
        <FolderBrowser
          conn={conn}
          mode="folder"
          initial={explorerStart(cwd)}
          onClose={() => setInPage(false)}
          onPick={(p) => {
            setCwd(cwdFromPickedFolder(p, shell.id));
            setCwdTouched(true);
            setInPage(false);
          }}
        />
      )}
    </div>
  );
}

function Radio({
  checked,
  disabled,
  onClick,
  label,
  hint,
}: {
  checked: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-left",
        checked ? "border-accent bg-accent-soft" : "border-border hover:bg-bg-hover",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span className={cn("mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border-2", checked ? "border-accent bg-accent" : "border-border-strong")} />
      <span className="min-w-0">
        <span className="block text-[12px] text-text-1">{label}</span>
        <span className="block truncate text-[10px] text-text-3">{hint}</span>
      </span>
    </button>
  );
}
