import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Folder, FolderGit2, GitBranch, GitCompareArrows, Loader2, PanelRightClose, RefreshCw } from "lucide-react";
import { FileKindIcon } from "./FileKindIcon";
import type { Connection } from "@/lib/connection";
import { changeAbsPath, changeCounts, joinFolder, splitRel, type WorktreeChange } from "@/lib/worktree";
import { cn } from "@/lib/utils";

// Sidebar da direita de UMA guia. A pasta é a do terminal em foco nessa
// guia; o componente é montado de novo quando a guia muda, então a árvore
// aberta de uma guia não aparece na outra.

type Entry = { name: string; is_dir: boolean };
type Listing = { path: string; parent: string; entries: Entry[] };
type GitInfo = { path: string; repo: boolean; root: string; branch: string; changes: WorktreeChange[] };

const STATUS_COLOR: Record<string, string> = {
  alterado: "text-status-warn",
  novo: "text-status-ok",
  adicionado: "text-status-ok",
  apagado: "text-status-err",
  renomeado: "text-accent-text",
};

export function WorktreePanel({
  conn,
  folder,
  folderLabel,
  onClose,
  onOpenFile,
}: {
  conn: Connection;
  /** pasta do terminal em foco, caminho que o Go abre; "" = a guia não tem pasta */
  folder: string;
  folderLabel: string;
  onClose: () => void;
  onOpenFile: (path: string) => void;
}) {
  const [list, setList] = useState<Listing | null>(null);
  const [open, setOpen] = useState<Record<string, Entry[] | "loading" | "err">>({});
  const [git, setGit] = useState<GitInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"arquivos" | "git">("arquivos");

  const load = useCallback(async () => {
    if (!folder) {
      setList(null);
      setGit(null);
      setError(null);
      return;
    }
    setError(null);
    try {
      const [files, changes] = await Promise.all([
        conn.api<Listing>("/api/local-fs/list", { path: folder }),
        conn.api<GitInfo>("/api/worktree", { path: folder }).catch((e: unknown) => {
          setError(e instanceof Error ? e.message : "não foi possível ler o git");
          return null;
        }),
      ]);
      setList(files);
      if (changes) setGit(changes);
    } catch (e) {
      setError(e instanceof Error ? e.message : "não foi possível ler a pasta");
    }
  }, [conn, folder]);

  useEffect(() => {
    setOpen({});
    setList(null);
    setGit(null);
    void load();
  }, [load]);

  // A pasta muda enquanto o agente trabalha; relê sem mexer nas pastas abertas.
  useEffect(() => {
    if (!folder) return;
    const id = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(id);
  }, [folder, load]);

  const toggle = async (path: string) => {
    if (open[path] && open[path] !== "err") {
      setOpen((o) => {
        const next = { ...o };
        delete next[path];
        return next;
      });
      return;
    }
    setOpen((o) => ({ ...o, [path]: "loading" }));
    try {
      const r = await conn.api<Listing>("/api/local-fs/list", { path });
      setOpen((o) => ({ ...o, [path]: r.entries }));
    } catch {
      setOpen((o) => ({ ...o, [path]: "err" }));
    }
  };

  const counts = changeCounts(git?.changes ?? []);
  const name = folderLabel || folder;

  const shortName = name.split(/[\\/]/).filter(Boolean).pop() || name;

  return (
    <aside className="bt-worktree flex h-full w-full flex-col rounded-xl border border-border bg-bg-panel text-[12.5px] text-text-1">
      <div className="flex h-11 shrink-0 items-center gap-2 px-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-bg-card text-text-2">
          <FolderGit2 size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium leading-4" title={folder || "Esta guia não tem pasta"}>
            {shortName || "Sem pasta"}
          </span>
          {folder && name !== shortName && <span className="block truncate text-[10px] leading-3 text-text-3">{name}</span>}
        </span>
        <button className="rounded-md p-1.5 text-text-2 hover:bg-bg-hover hover:text-text-1" title="Atualizar" onClick={() => void load()}>
          <RefreshCw size={13} />
        </button>
        <button className="rounded-md p-1.5 text-text-2 hover:bg-bg-hover hover:text-text-1" title="Fechar a pasta desta guia" onClick={onClose}>
          <PanelRightClose size={14} />
        </button>
      </div>
      <div className="mx-3 mb-1 flex shrink-0 gap-1 rounded-lg bg-bg-card p-0.5">
        {(["arquivos", "git"] as const).map((id) => (
          <button
            key={id}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-text-2 transition-colors hover:text-text-1",
              tab === id && "bg-bg-hover text-text-1 shadow-sm",
            )}
            onClick={() => setTab(id)}
          >
            {id === "arquivos" ? <Folder size={13} className="shrink-0" aria-hidden /> : <GitCompareArrows size={13} className="shrink-0" aria-hidden />}
            {id === "arquivos" ? "Arquivos" : `Mudanças${git?.changes.length ? ` · ${git.changes.length}` : ""}`}
          </button>
        ))}
      </div>
      {!folder ? (
        <p className="px-3 py-4 text-text-3">Esta guia não tem um terminal com pasta.</p>
      ) : error && !list ? (
        <p className="px-3 py-4 text-status-err">{error}</p>
      ) : tab === "arquivos" ? (
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {!list ? (
            <Loader2 size={14} className="m-3 animate-spin text-text-3" />
          ) : (
            list.entries.map((e) => (
              <TreeRow
                key={e.name}
                entry={e}
                path={joinFolder(list.path, e.name)}
                depth={0}
                open={open}
                onToggle={toggle}
                onOpenFile={onOpenFile}
              />
            ))
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {!git ? (
            <Loader2 size={14} className="m-3 animate-spin text-text-3" />
          ) : !git.repo ? (
            <p className="px-3 py-4 text-text-3">Esta pasta não está num repositório git.</p>
          ) : (
            <>
              <div className="mx-2 mb-1 flex items-center gap-1.5 rounded-md bg-bg-card px-2 py-1.5 text-[11px] text-text-2">
                <GitBranch size={12} className="shrink-0" />
                <span className="truncate font-medium text-text-1" title={git.root}>{git.branch || "git"}</span>
                {counts.map((c) => (
                  <span key={c.status} className={STATUS_COLOR[c.status] ?? "text-text-2"}>
                    {c.n} {c.status}{c.n > 1 ? "s" : ""}
                  </span>
                ))}
              </div>
              {git.changes.length === 0 ? (
                <p className="px-3 py-2 text-text-3">Nenhuma mudança nesta pasta.</p>
              ) : (
                git.changes.map((c) => {
                  const { dir, name } = splitRel(c.path);
                  const abs = changeAbsPath(folder, c.path);
                  return (
                    <button
                      key={c.path}
                      className="mx-1.5 flex w-[calc(100%-12px)] items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-bg-hover disabled:hover:bg-transparent"
                      title={c.path}
                      disabled={!abs || c.status === "apagado"}
                      onClick={() => abs && onOpenFile(abs)}
                    >
                      <span className={cn("w-14 shrink-0 text-[10px]", STATUS_COLOR[c.status] ?? "text-text-3")}>{c.status}</span>
                      <FileKindIcon name={name} size={18} />
                      <span className="min-w-0 flex-1 truncate text-text-1">
                        {name}
                        {dir && <span className="text-text-3"> {dir}</span>}
                      </span>
                    </button>
                  );
                })
              )}
              {error && <p className="px-3 py-2 text-status-err">{error}</p>}
            </>
          )}
        </div>
      )}
    </aside>
  );
}

function TreeRow({
  entry,
  path,
  depth,
  open,
  onToggle,
  onOpenFile,
}: {
  entry: Entry;
  path: string;
  depth: number;
  open: Record<string, Entry[] | "loading" | "err">;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const state = open[path];
  const expanded = Array.isArray(state);
  return (
    <>
      <button
        className="mx-1.5 flex w-[calc(100%-12px)] items-center gap-1 rounded-md py-1 pr-2 text-left hover:bg-bg-hover"
        style={{ paddingLeft: 8 + depth * 12 }}
        title={path}
        onClick={() => (entry.is_dir ? onToggle(path) : onOpenFile(path))}
      >
        {entry.is_dir ? (
          <ChevronRight size={12} className={cn("shrink-0 text-text-3", expanded && "rotate-90")} />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <FileKindIcon name={entry.name} isDir={entry.is_dir} open={expanded} size={18} />
        <span className="min-w-0 flex-1 truncate text-text-1">{entry.name}</span>
        {state === "loading" && <Loader2 size={11} className="animate-spin text-text-3" />}
      </button>
      {expanded &&
        state.map((e) => (
          <TreeRow
            key={e.name}
            entry={e}
            path={joinFolder(path, e.name)}
            depth={depth + 1}
            open={open}
            onToggle={onToggle}
            onOpenFile={onOpenFile}
          />
        ))}
      {state === "err" && (
        <p className="py-0.5 text-status-err" style={{ paddingLeft: 28 + depth * 12 }}>
          não foi possível ler
        </p>
      )}
    </>
  );
}
