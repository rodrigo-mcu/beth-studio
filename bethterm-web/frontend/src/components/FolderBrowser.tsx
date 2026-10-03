import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronRight, File, FileText, Folder, FolderPlus, HardDrive, Home, Loader2, RefreshCw, TerminalSquare, X } from "lucide-react";
import type { Connection } from "@/lib/connection";
import { crumbs, joinPath, NEW_FILE_EXTS, newFileNameError, openableFile, rootLabel, withTextExt, wslFromUNC } from "@/lib/folderBrowser";
import { cn } from "@/lib/utils";

// Navegador de pastas DENTRO da página (POST /api/local-fs/list): escolher
// pasta, abrir arquivo ou criar arquivo de texto. Funciona igual no PC e no
// Studio remoto (lá não existe o "Procurar" do Windows).

type Entry = { name: string; size: number; is_dir: boolean; mtime: number };
type Listing = { path: string; parent: string; entries: Entry[]; roots?: string[]; home?: string; wsl?: string[] };

export type FolderBrowserMode = "folder" | "file" | "new-file";

const LAST_KEY = "bethterm.folderBrowser.last";

function loadLast(): string {
  try {
    return localStorage.getItem(LAST_KEY) ?? "";
  } catch {
    return "";
  }
}
function saveLast(p: string) {
  try {
    localStorage.setItem(LAST_KEY, p);
  } catch {
    /* sem storage */
  }
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(sec: number): string {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" }) + " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

const TITLE: Record<FolderBrowserMode, string> = {
  folder: "Escolher pasta",
  file: "Abrir arquivo",
  "new-file": "Salvar como",
};

export function FolderBrowser({
  conn,
  mode,
  initial,
  onPick,
  onClose,
  content = "",
}: {
  conn: Connection;
  mode: FolderBrowserMode;
  /** pasta inicial (Windows ou \\wsl.localhost\...); "" = a última usada ou a do usuário */
  initial?: string;
  /** pasta escolhida, arquivo escolhido, ou o arquivo criado */
  onPick: (path: string) => void;
  /** "new-file": o texto que vai no arquivo novo */
  content?: string;
  onClose: () => void;
}) {
  const [list, setList] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [newDir, setNewDir] = useState<string | null>(null);
  // trilha virou campo: digitar ou colar um caminho
  const [typed, setTyped] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [ext, setExt] = useState<string>(NEW_FILE_EXTS[0]);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const go = useCallback(
    async (path: string, fallback?: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const r = await conn.api<Listing>("/api/local-fs/list", { path });
        setList(r);
        setSelected(null);
        saveLast(r.path);
        listRef.current?.scrollTo({ top: 0 });
      } catch (e) {
        // pasta inicial que não existe mais: cai na do usuário
        if (fallback && path) return go("", false);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [conn],
  );

  useEffect(() => {
    void go(initial || loadLast(), true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (mode === "new-file") window.setTimeout(() => nameRef.current?.focus(), 50);
  }, [mode]);

  const entries = useMemo(() => {
    const all = list?.entries ?? [];
    if (mode === "folder") return all.filter((e) => e.is_dir);
    return all;
  }, [list, mode]);

  const places = useMemo(() => {
    const out: { label: string; path: string; icon: "home" | "disk" | "linux" }[] = [];
    if (list?.home) out.push({ label: "Pasta do usuário", path: list.home, icon: "home" });
    for (const r of list?.roots ?? []) out.push({ label: rootLabel(r), path: r, icon: "disk" });
    for (const r of list?.wsl ?? []) out.push({ label: rootLabel(r), path: r, icon: "linux" });
    return out;
  }, [list]);

  const cur = list?.path ?? "";
  const linux = wslFromUNC(cur);

  const mkdir = async () => {
    const n = (newDir ?? "").trim();
    if (!n || !cur) return;
    if (/[\\/:*?"<>|]/.test(n)) {
      setError('O nome da pasta não pode ter \\ / : * ? " < > |');
      return;
    }
    setBusy(true);
    try {
      await conn.api("/api/local-fs/mkdir", { path: joinPath(cur, n) });
      setNewDir(null);
      await go(joinPath(cur, n));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const finalName = withTextExt(fileName, ext);
  const nameErr = mode === "new-file" && fileName ? newFileNameError(finalName) : "";

  const create = async () => {
    if (!cur || !fileName.trim() || nameErr) return;
    setBusy(true);
    setError(null);
    try {
      const r = await conn.api<{ path: string }>("/api/local-file/create", { path: joinPath(cur, finalName), content });
      onPick(r.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const activate = (e: Entry) => {
    const p = joinPath(cur, e.name);
    if (e.is_dir) void go(p);
    else if (mode === "file" && openableFile(e.name)) onPick(p);
    else if (mode === "new-file") setFileName(e.name.replace(/\.[^.]*$/, ""));
  };

  const selEntry = entries.find((e) => joinPath(cur, e.name) === selected);
  const canOpenFile = mode === "file" && !!selEntry && !selEntry.is_dir && openableFile(selEntry.name);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/40 pt-[6vh]"
      onMouseDown={(e) => {
        // pode estar dentro de outro diálogo (Nova aba): o clique fora fecha só este
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="flex h-[min(640px,86vh)] w-[min(820px,95vw)] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-card shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        {/* título */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          {mode === "new-file" ? <FileText size={16} className="text-accent-text" /> : <Folder size={16} className="text-accent-text" />}
          <div className="flex-1 text-[15px] font-semibold text-text-1">{TITLE[mode]}</div>
          <button className="rounded p-1 text-text-2 hover:bg-bg-hover hover:text-text-1" title="Fechar" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* barra: subir, trilha, recarregar, nova pasta */}
        <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
          <button
            className="rounded p-1.5 text-text-2 hover:bg-bg-hover hover:text-text-1 disabled:opacity-40"
            title="Pasta de cima"
            disabled={!list?.parent}
            onClick={() => list?.parent && void go(list.parent)}
          >
            <ArrowUp size={15} />
          </button>
          {typed !== null ? (
            <input
              autoFocus
              value={typed}
              spellCheck={false}
              className="h-7 min-w-0 flex-1 rounded border border-accent bg-bg-term px-2 font-mono text-[12px] text-text-1 outline-none"
              onChange={(e) => setTyped(e.target.value)}
              onBlur={() => setTyped(null)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && typed.trim()) {
                  void go(typed.trim());
                  setTyped(null);
                }
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setTyped(null);
                }
              }}
            />
          ) : (
          <div
            className="flex min-w-0 flex-1 cursor-text items-center overflow-x-auto rounded border border-border bg-bg-term px-1.5 py-1 text-[12px]"
            title="Clique aqui para digitar ou colar um caminho"
            onClick={(e) => e.target === e.currentTarget && setTyped(cur)}
          >
            {crumbs(cur).map((c, i) => (
              <span key={c.path} className="flex shrink-0 items-center">
                {i > 0 && <ChevronRight size={12} className="mx-0.5 text-text-3" />}
                <button className="rounded px-1 text-text-1 hover:bg-bg-hover" title={c.path} onClick={() => void go(c.path)}>
                  {c.label}
                </button>
              </span>
            ))}
            <span className="min-w-6 flex-1 self-stretch" onClick={() => setTyped(cur)} />
          </div>
          )}
          <button className="rounded p-1.5 text-text-2 hover:bg-bg-hover hover:text-text-1" title="Atualizar" onClick={() => void go(cur)}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
          <button
            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[12px] text-text-1 hover:bg-bg-hover"
            title="Criar uma pasta aqui"
            onClick={() => setNewDir("")}
          >
            <FolderPlus size={14} /> Nova pasta
          </button>
        </div>
        {newDir !== null && (
          <div className="flex items-center gap-2 border-b border-border bg-bg-panel px-3 py-2">
            <FolderPlus size={14} className="text-text-2" />
            <input
              autoFocus
              value={newDir}
              placeholder="Nome da pasta nova"
              className="h-7 min-w-0 flex-1 rounded border border-border bg-bg-term px-2 text-[13px] text-text-1 outline-none focus:border-accent"
              onChange={(e) => setNewDir(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void mkdir();
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setNewDir(null);
                }
              }}
            />
            <button disabled={busy || !newDir.trim()} className="rounded bg-accent px-2.5 py-1 text-[12px] text-white disabled:opacity-50" onClick={() => void mkdir()}>
              Criar pasta
            </button>
            <button className="px-1.5 text-[12px] text-text-2 hover:text-text-1" onClick={() => setNewDir(null)}>
              Cancelar
            </button>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          {/* atalhos */}
          <div className="w-44 shrink-0 overflow-y-auto border-r border-border p-1.5">
            {places.map((p) => {
              const Icon = p.icon === "home" ? Home : p.icon === "linux" ? TerminalSquare : HardDrive;
              const active = cur.toLowerCase() === p.path.toLowerCase();
              return (
                <button
                  key={p.path}
                  title={p.path}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px]",
                    active ? "bg-accent-soft text-accent-text" : "text-text-1 hover:bg-bg-hover",
                  )}
                  onClick={() => void go(p.path)}
                >
                  <Icon size={14} className="shrink-0" />
                  <span className="truncate">{p.label}</span>
                </button>
              );
            })}
          </div>

          {/* conteúdo da pasta */}
          <div ref={listRef} className="min-w-0 flex-1 overflow-y-auto">
            {error && <div className="m-2 rounded bg-status-err/15 px-2.5 py-1.5 text-[12px] text-status-err">{error}</div>}
            {!list && loading && (
              <div className="flex items-center gap-2 p-4 text-text-2">
                <Loader2 size={14} className="animate-spin" /> Lendo a pasta…
              </div>
            )}
            {list && entries.length === 0 && !loading && (
              <div className="p-4 text-[13px] text-text-3">{mode === "folder" ? "Nenhuma subpasta." : "Pasta vazia."}</div>
            )}
            {entries.map((e) => {
              const p = joinPath(cur, e.name);
              const dimmed = mode === "file" && !e.is_dir && !openableFile(e.name);
              return (
                <button
                  key={e.name}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px]",
                    selected === p ? "bg-accent-soft" : "hover:bg-bg-hover",
                    dimmed && "opacity-45",
                  )}
                  title={e.is_dir ? "Clique duas vezes para entrar" : e.name}
                  onClick={() => setSelected(p)}
                  onDoubleClick={() => activate(e)}
                >
                  {e.is_dir ? (
                    <Folder size={15} className="shrink-0 text-accent-text" />
                  ) : openableFile(e.name) ? (
                    <FileText size={15} className="shrink-0 text-text-2" />
                  ) : (
                    <File size={15} className="shrink-0 text-text-3" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-text-1">{e.name}</span>
                  {!e.is_dir && <span className="shrink-0 text-[11px] text-text-3">{fmtSize(e.size)}</span>}
                  <span className="w-24 shrink-0 text-right text-[11px] text-text-3">{fmtDate(e.mtime)}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* rodapé: caminho e ação */}
        <div className="space-y-2 border-t border-border px-3 py-2.5">
          {mode === "new-file" && (
            <div className="flex items-center gap-2">
              <label className="shrink-0 text-[12px] text-text-2" htmlFor="fb-name">
                Nome
              </label>
              <input
                id="fb-name"
                ref={nameRef}
                value={fileName}
                placeholder="notas"
                className="h-8 min-w-0 flex-1 rounded border border-border bg-bg-term px-2 text-[13px] text-text-1 outline-none focus:border-accent"
                onChange={(e) => setFileName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void create()}
              />
              <select
                value={ext}
                className="h-8 rounded border border-border bg-bg-term px-1.5 text-[13px] text-text-1"
                title="Tipo do arquivo (se o nome não disser)"
                onChange={(e) => setExt(e.target.value)}
              >
                {NEW_FILE_EXTS.map((x) => (
                  <option key={x} value={x}>
                    {x === ".md" ? "Markdown (.md)" : "Texto (.txt)"}
                  </option>
                ))}
              </select>
            </div>
          )}
          {nameErr && <div className="text-[12px] text-status-err">{nameErr}</div>}
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-3" title={cur}>
              {mode === "new-file" && fileName.trim() ? joinPath(cur, finalName) : mode === "file" && selected ? selected : cur}
              {linux && mode === "folder" && <span className="ml-2 text-text-2">· no Linux: {linux.path}</span>}
            </div>
            <button className="rounded px-3 py-1.5 text-[13px] text-text-2 hover:bg-bg-hover hover:text-text-1" onClick={onClose}>
              Cancelar
            </button>
            {mode === "folder" && (
              <button
                disabled={!cur}
                className="rounded bg-accent px-3 py-1.5 text-[13px] text-white disabled:opacity-50"
                onClick={() => {
                  const sel = entries.find((e) => e.is_dir && joinPath(cur, e.name) === selected);
                  onPick(sel ? joinPath(cur, sel.name) : cur);
                }}
              >
                {selEntry?.is_dir ? `Escolher "${selEntry.name}"` : "Escolher esta pasta"}
              </button>
            )}
            {mode === "file" && (
              <button
                disabled={!canOpenFile}
                className="rounded bg-accent px-3 py-1.5 text-[13px] text-white disabled:opacity-50"
                title={canOpenFile ? "" : "Escolha um arquivo .md, .txt, .log ou uma imagem"}
                onClick={() => selected && onPick(selected)}
              >
                Abrir
              </button>
            )}
            {mode === "new-file" && (
              <button
                disabled={busy || !fileName.trim() || !!nameErr || !cur}
                className="rounded bg-accent px-3 py-1.5 text-[13px] text-white disabled:opacity-50"
                onClick={() => void create()}
              >
                {busy ? "Salvando…" : "Salvar"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
