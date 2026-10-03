import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import {
  AArrowDown,
  AArrowUp,
  AlertTriangle,
  ClipboardCopy,
  ClipboardPaste,
  Code,
  Copy,
  ExternalLink,
  Eye,
  FileOutput,
  FilePlus,
  FolderOpen,
  Link,
  Maximize2,
  Minimize2,
  NotebookText,
  PanelLeft,
  PanelRight,
  Pencil,
  Plus,
  Ratio,
  Save,
  Scan,
  Scissors,
  TextSelect,
  Trash2,
  WrapText,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { Connection } from "@/lib/connection";
import { copyText, readClipboard } from "@/lib/clipboard";
import { openExternal } from "@/lib/links";
import { localFileKind, localFileURL } from "@/lib/localFile";
import { download, isRemote, sinceLabel } from "@/lib/remote";
import { loadScratch, saveScratch, UNTITLED_PATH } from "@/lib/folderBrowser";
import { notesApi, noteWhen, type NoteInfo } from "@/lib/notes";
import { clampRect, defaultRect, dockRect, isRect, moveRect, resizeRect, type Edge, type Rect } from "@/lib/panelRect";

const REMOTE = isRemote();
import { renderMarkdownSafe } from "@/lib/markdownSafe";
import {
  FONT_DEFAULT,
  copyAllText,
  detectEol,
  editableText,
  fileBaseName,
  loadPref,
  savePref,
  stepFont,
  stepZoom,
  toDiskText,
  type Eol,
  type PreviewView,
} from "@/lib/filePreview";
import { cn } from "@/lib/utils";
import { IconButton } from "./IconButton";

interface Props {
  conn: Connection;
  /** Caminho local já RESOLVIDO (absoluto Windows ou \\wsl.localhost\..., ver lib/localFile.ts). */
  path: string;
  onClose: () => void;
  /** link local dentro do documento (outro .md/.txt/imagem): abre neste mesmo painel */
  onOpen: (path: string) => void;
  /** arquivo recém-criado: quando ESTE caminho carregar, já entra em "Editar" */
  editOnOpen?: string | null;
  /** "Novo arquivo" a partir da pasta deste arquivo */
  onNewFile?: (dir: string) => void;
  /** texto "Sem título" (path = UNTITLED_PATH): Salvar pede onde gravar */
  onSaveUntitled?: (content: string) => void;
}

type Doc =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "text"; raw: string; truncated: boolean; size: number; markdown: boolean; mtime: string }
  | { phase: "image"; url: string };

const PREF_FONT = "bt.preview.font";
const PREF_WRAP = "bt.preview.wrap";
const PREF_SIZE = "bt.preview.size";
const PREF_RECT = "bt.preview.rect";
const PREF_NOTES = "bt.preview.notes";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isSize = (v: unknown): v is { w: number; h: number } =>
  !!v && typeof v === "object" && isNum((v as { w: unknown }).w) && isNum((v as { h: unknown }).h);

/** posição e tamanho do painel: o último usado; senão o tamanho antigo, no canto superior direito */
function initialRect(): Rect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const saved = loadPref<Rect | null>(PREF_RECT, null, (v): v is Rect => isRect(v));
  if (saved) return clampRect(saved, vw, vh);
  const sz = loadPref(PREF_SIZE, { w: 680, h: Math.round(vh * 0.75) }, isSize);
  return defaultRect(sz.w, sz.h, vw, vh);
}

/**
 * Painel flutuante DENTRO do app para ver e editar um arquivo local (texto
 * ou imagem): aberto por um caminho detectado na saída de um terminal ou
 * por "Abrir arquivo…" da barra de abas — nunca abre no navegador nem no
 * editor padrão sozinho (só os botões explícitos). Fica por cima de tudo
 * mas não bloqueia o terminal atrás; redimensionável (bordas esquerda e de
 * baixo) e maximizável. Esc fecha; Ctrl+A seleciona só o conteúdo do
 * painel. Texto (.md/.txt/.log mostrado inteiro) tem o modo "Editar": Ctrl+S
 * grava no próprio arquivo; se ele mudou no disco depois de aberto, pergunta
 * antes de sobrescrever; fechar/abrir outro com alteração pendente pergunta.
 * Fora do modo editar, Ctrl+S salva uma cópia.
 */
export function FilePreviewPanel({ conn, path: requested, onClose, onOpen, editOnOpen, onNewFile, onSaveUntitled }: Props) {
  // arquivo mostrado; troca de "requested" com alteração pendente espera a resposta do aviso
  const [path, setPath] = useState(requested);
  const [doc, setDoc] = useState<Doc>({ phase: "loading" });
  const [draft, setDraft] = useState<string | null>(null); // null = só vendo
  const [eol, setEol] = useState<Eol>("\n");
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<{ kind: "close" } | { kind: "stop" } | { kind: "open"; path: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [view, setView] = useState<PreviewView>("rendered");
  const [wrap, setWrap] = useState(() => loadPref(PREF_WRAP, true, isBool));
  const [font, setFont] = useState(() => loadPref(PREF_FONT, FONT_DEFAULT, isNum));
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [rect, setRect] = useState<Rect>(initialRect);
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const [hasSel, setHasSel] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; editing?: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // "Sem título": texto só na memória até a pessoa salvar
  const untitled = path === UNTITLED_PATH;
  const [scratch, setScratch] = useState(() => (untitled ? loadScratch() : null));
  const kind = localFileKind(path);
  const name = untitled ? "Sem título" : fileBaseName(path);
  const markdown = untitled || /\.(md|markdown)$/i.test(path);
  const isText = doc.phase === "text";

  // Notas: o "Sem título" é salvo sozinho em <dados>\notes (um .md com timestamp
  // por nota). A lista lateral abre e apaga notas.
  const [notes, setNotes] = useState<NoteInfo[]>([]);
  const [notesOpen, setNotesOpen] = useState(() => loadPref(PREF_NOTES, true, isBool));
  const [noteId, setNoteId] = useState<string | null>(null);
  const [savedText, setSavedText] = useState("");
  const [askDelete, setAskDelete] = useState<string | null>(null);
  const noteIdRef = useRef<string | null>(null);
  const savedTextRef = useRef("");
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const wantNote = useRef<{ id: string; text: string } | null>(null);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 1600);
  }, []);

  const dirty = draft !== null && doc.phase === "text" && draft !== editableText(doc.raw);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const untitledRef = useRef(untitled);
  untitledRef.current = untitled;

  const setNoteState = (id: string | null, text: string) => {
    noteIdRef.current = id;
    savedTextRef.current = text;
    setNoteId(id);
    setSavedText(text);
  };
  /** grava o texto do "Sem título" na nota (cria na primeira vez); uma gravação por vez */
  const persistNote = (): Promise<void> => {
    saveChain.current = saveChain.current.then(async () => {
      const text = draftRef.current;
      if (!untitledRef.current || !text || !text.trim() || text === savedTextRef.current) return;
      try {
        const r = await notesApi.save(conn, noteIdRef.current, text);
        noteIdRef.current = r.id;
        savedTextRef.current = text;
        setNoteId(r.id);
        setSavedText(text);
        setNotes(r.notes);
      } catch (e) {
        saveScratch(text); // última chance: "Recuperar" no próximo Novo arquivo
        flash(`Não salvou em Notas: ${(e as Error).message}`);
      }
    });
    return saveChain.current;
  };

  useEffect(() => {
    void notesApi.list(conn).then((r) => setNotes(r.notes)).catch(() => undefined);
  }, [conn]);

  // salva sozinho 1,5 s depois da última tecla
  useEffect(() => {
    if (!untitled || !draft || !draft.trim() || draft === savedTextRef.current) return;
    const t = window.setTimeout(() => void persistNote(), 1500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, untitled]);

  /** nota nova em branco (a atual já foi salva) */
  const newNote = async () => {
    await persistNote();
    wantNote.current = null;
    setNoteState(null, "");
    if (untitledRef.current) {
      setDraft("");
      setView("source");
      window.setTimeout(() => textareaRef.current?.focus({ preventScroll: true }), 0);
    } else onOpen(UNTITLED_PATH);
  };
  const openNote = async (id: string) => {
    if (untitledRef.current && id === noteIdRef.current) return;
    await persistNote();
    try {
      const r = await notesApi.read(conn, id);
      if (untitledRef.current) {
        setNoteState(id, r.text);
        setDraft(r.text);
        setView("source");
        window.setTimeout(() => textareaRef.current?.focus({ preventScroll: true }), 0);
      } else {
        wantNote.current = { id, text: r.text };
        onOpen(UNTITLED_PATH);
      }
    } catch (e) {
      flash(`Erro: ${(e as Error).message}`);
    }
  };
  const deleteNote = async (id: string) => {
    setAskDelete(null);
    try {
      const r = await notesApi.remove(conn, id);
      setNotes(r.notes);
      if (id === noteIdRef.current) {
        setNoteState(null, "");
        if (untitledRef.current) setDraft("");
      }
      flash("Nota apagada");
    } catch (e) {
      flash(`Erro: ${(e as Error).message}`);
    }
  };
  // nota escolhida na lista enquanto havia outro arquivo aberto: carrega quando o "Sem título" abrir
  useEffect(() => {
    const w = wantNote.current;
    if (!w || !untitled || doc.phase !== "text" || draft === null) return;
    wantNote.current = null;
    setNoteState(w.id, w.text);
    setDraft(w.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [untitled, doc.phase, draft]);

  // outro arquivo pedido (link local, clique no terminal, "Abrir arquivo…")
  useEffect(() => {
    if (requested === path) return;
    if (untitledRef.current) void persistNote().then(() => setPath(requested)); // a nota já fica salva
    else if (dirtyRef.current) setPending({ kind: "open", path: requested });
    else setPath(requested);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested]);

  // carrega (e recarrega ao navegar para outro arquivo pelo link local)
  useEffect(() => {
    let alive = true;
    setDoc({ phase: "loading" });
    setDraft(null);
    setConflict(false);
    setPending(null);
    setView("rendered");
    setZoom("fit");
    setNatural(null);
    if (path === UNTITLED_PATH) {
      if (!wantNote.current) setNoteState(null, "");
      setDoc({ phase: "text", raw: "", truncated: false, size: 0, markdown: true, mtime: "" });
      return;
    }
    if (kind === "image") {
      setDoc({ phase: "image", url: localFileURL(path) });
      return;
    }
    if (kind !== "text") {
      setDoc({ phase: "error", message: "Tipo de arquivo não suportado no preview." });
      return;
    }
    void (async () => {
      try {
        const { blob, headers } = await conn.getBlob(localFileURL(path));
        const raw = await blob.text();
        if (!alive) return;
        setDoc({
          phase: "text",
          raw,
          truncated: headers.get("X-Truncated") === "1",
          size: Number(headers.get("X-File-Size") || raw.length),
          markdown,
          mtime: headers.get("X-File-Mtime") ?? "",
        });
      } catch (e) {
        if (alive) setDoc({ phase: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [conn, path, kind, markdown, reloadKey]);

  // foco no painel ao abrir: Esc / Ctrl+A / Ctrl+S valem aqui, não no terminal
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, [path]);

  // "Copiar seleção" só com seleção DENTRO do conteúdo do painel
  useEffect(() => {
    const onSel = () => {
      const s = window.getSelection();
      const el = contentRef.current;
      setHasSel(!!s && !s.isCollapsed && !!el && !!s.anchorNode && !!s.focusNode && el.contains(s.anchorNode) && el.contains(s.focusNode));
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const html = useMemo(
    () => (doc.phase === "text" && doc.markdown ? renderMarkdownSafe(draft ?? doc.raw, { filePath: path }) : ""),
    [doc, draft, path],
  );

  // --- ações ----------------------------------------------------------------
  const api = useCallback(
    async <T,>(route: string): Promise<T | null> => {
      try {
        return await conn.api<T>(route, { path });
      } catch (e) {
        flash(`Erro: ${(e as Error).message}`);
        return null;
      }
    },
    [conn, path, flash],
  );
  const copyAll = async () => {
    if (doc.phase !== "text") return;
    flash((await copyText(copyAllText({ raw: draft ?? doc.raw }, view))) ? "Copiado" : "Não foi possível copiar");
  };
  const selectionText = () => (hasSel ? (window.getSelection()?.toString() ?? "") : "");
  const copySelection = async () => {
    const t = selectionText();
    if (t) flash((await copyText(t)) ? "Copiado" : "Não foi possível copiar");
  };
  const selectAll = () => {
    if (draft !== null && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
      return;
    }
    const el = contentRef.current;
    if (el && doc.phase === "text") window.getSelection()?.selectAllChildren(el);
  };
  const copyPath = async () => flash((await copyText(path)) ? "Caminho copiado" : "Não foi possível copiar");
  const saveAs = async () => {
    if (untitled) {
      onSaveUntitled?.(toDiskText(draft ?? "", eol));
      return;
    }
    if (REMOTE) {
      download(path.split(/[\\/]/).pop() || "arquivo", `${localFileURL(path)}&download=1`);
      return;
    }
    const r = await api<{ path?: string; canceled?: boolean }>("/api/local-file/save-as");
    if (r?.path) flash(`Salvo em ${r.path}`);
  };
  const openDefault = () => void api("/api/local-file/open-default");

  // --- editar -----------------------------------------------------------------
  const canEdit = doc.phase === "text" && !doc.truncated;
  const startEdit = () => {
    if (doc.phase !== "text" || doc.truncated) return;
    setDraft(editableText(doc.raw));
    setEol(detectEol(doc.raw));
    setView("source");
    window.setTimeout(() => textareaRef.current?.focus({ preventScroll: true }), 0);
  };
  // Arquivo novo: abre direto no modo Editar (uma vez por caminho).
  const autoEditedRef = useRef<string | null>(null);
  useEffect(() => {
    if ((editOnOpen !== path && !untitled) || autoEditedRef.current === path) return;
    if (doc.phase !== "text" || draft !== null) return;
    autoEditedRef.current = path;
    startEdit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editOnOpen, path, doc.phase, untitled]);
  /** grava no próprio arquivo; true = salvou */
  const save = async (force = false): Promise<boolean> => {
    if (untitled) {
      // ainda não tem arquivo: escolher pasta e nome (o painel reabre com o arquivo salvo)
      onSaveUntitled?.(toDiskText(draft ?? "", eol));
      return false;
    }
    if (draft === null || doc.phase !== "text" || saving) return false;
    const content = toDiskText(draft, eol);
    setSaving(true);
    try {
      const r = await conn.api<{ mtime?: string }>("/api/local-file/write", { path, content, mtime: doc.mtime, force });
      setDoc({ ...doc, raw: content, size: new Blob([content]).size, mtime: r.mtime ?? "" });
      setConflict(false);
      flash("Salvo");
      return true;
    } catch (e) {
      if ((e as { status?: number }).status === 409) setConflict(true);
      else flash(`Erro: ${(e as Error).message}`);
      return false;
    } finally {
      setSaving(false);
    }
  };
  // menu do botão direito no editor (o menu nativo do WebView2 fica desligado)
  const editSelection = () => {
    const ta = textareaRef.current;
    return ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : "";
  };
  const replaceSelection = (text: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
    setDraft(ta.value);
  };
  const editCopy = async () => {
    const t = editSelection();
    if (t) flash((await copyText(t)) ? "Copiado" : "Não foi possível copiar");
    textareaRef.current?.focus();
  };
  const editCut = async () => {
    const t = editSelection();
    if (!t) return;
    if (await copyText(t)) replaceSelection("");
    else flash("Não foi possível copiar");
  };
  const editPaste = async () => {
    const t = await readClipboard();
    if (t === null) flash("Sem acesso à área de transferência: use Ctrl+V");
    else if (t) replaceSelection(t.replace(/\r\n/g, "\n"));
  };
  const reloadFromDisk = () => setReloadKey((k) => k + 1);
  const requestClose = () => {
    // "Sem título" fecha sem perguntar; o texto fica para "Recuperar" no próximo
    if (untitled) {
      void persistNote().then(onClose);
      return;
    }
    if (dirty) setPending({ kind: "close" });
    else onClose();
  };
  const stopEdit = () => (dirty ? setPending({ kind: "stop" }) : setDraft(null));
  /** resposta do aviso "alterações não salvas" */
  const resolvePending = async (choice: "save" | "discard") => {
    const p = pending;
    if (!p) return;
    if (choice === "save" && !(await save())) return; // erro/conflito: o aviso de conflito aparece
    setPending(null);
    if (p.kind === "close") onClose();
    else if (p.kind === "stop") setDraft(null);
    else setPath(p.path);
  };
  const reveal = () => void api("/api/local-file/reveal");
  const changeFont = (d: number) =>
    setFont((f) => {
      const n = stepFont(f, d);
      savePref(PREF_FONT, n);
      return n;
    });
  const toggleWrap = () =>
    setWrap((w) => {
      savePref(PREF_WRAP, !w);
      return !w;
    });
  const effectiveZoom = (): number => {
    if (zoom !== "fit") return zoom;
    const img = imgRef.current;
    return img && natural?.w ? img.clientWidth / natural.w : 1;
  };
  const changeZoom = (dir: 1 | -1) => setZoom(stepZoom(effectiveZoom(), dir));

  const onKeyDown = (e: RKeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (menu) setMenu(null);
      else if (pending) setPending(null);
      else requestClose();
      return;
    }
    const inEditor = e.target instanceof HTMLTextAreaElement;
    if ((e.ctrlKey || e.metaKey) && k === "a" && !inEditor) {
      e.preventDefault();
      e.stopPropagation();
      selectAll();
    } else if ((e.ctrlKey || e.metaKey) && k === "s") {
      e.preventDefault();
      e.stopPropagation();
      if (draft !== null) void save();
      else void saveAs();
    }
  };

  // clique no conteúdo do Markdown: link local abre aqui; imagem remota abre no navegador
  const onContentClick = (e: RMouseEvent) => {
    const t = e.target as Element;
    const local = t.closest?.("[data-local-href]");
    if (local) {
      e.preventDefault();
      const p = local.getAttribute("data-local-href");
      if (p) onOpen(p);
      return;
    }
    const remote = t.closest?.(".md-remote-img");
    if (remote) {
      e.preventDefault();
      const u = remote.getAttribute("data-href");
      if (u) void openExternal(conn, u);
    }
  };

  // --- mover (arrastar o título) e redimensionar (qualquer borda ou canto) -----
  const dragRect = (apply: (start: Rect, dx: number, dy: number) => Rect) => (e: RPointerEvent) => {
    if (maximized || e.button !== 0) return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const start = rectRef.current;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setRect(apply(start, ev.clientX - sx, ev.clientY - sy));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      savePref(PREF_RECT, rectRef.current);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const startResize = (edge: Edge) => dragRect((start, dx, dy) => resizeRect(start, edge, dx, dy, window.innerWidth, window.innerHeight));
  const startMove = (e: RPointerEvent) => {
    if ((e.target as Element).closest("button")) return; // botões do título não arrastam
    dragRect((start, dx, dy) => moveRect(start, dx, dy, window.innerWidth, window.innerHeight))(e);
  };
  const dock = (side: "left" | "right") => {
    setMaximized(false);
    const r = dockRect(side, rectRef.current, window.innerWidth, window.innerHeight);
    setRect(r);
    savePref(PREF_RECT, r);
  };
  // janela do app menor: o painel volta para dentro dela
  useEffect(() => {
    const onResize = () => setRect((r) => clampRect(r, window.innerWidth, window.innerHeight));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const showSource = isText && (!doc.markdown || view === "source");
  const textStyle = { fontSize: `${font}px` };

  return (
    <div className="pointer-events-none fixed inset-0 z-50">
      <div
        ref={rootRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn(
          "pointer-events-auto absolute flex flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-card shadow-2xl outline-none",
          maximized && "inset-4",
        )}
        style={maximized ? undefined : { left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      >
        {/* título + janela */}
        <div
          className={cn("flex h-9 shrink-0 select-none items-center gap-2 border-b border-border px-3", !maximized && "cursor-move")}
          onPointerDown={startMove}
          onDoubleClick={(e) => !(e.target as Element).closest("button") && setMaximized((m) => !m)}
          title={maximized ? undefined : "Arraste para mover · duplo clique maximiza"}
        >
          <div className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-1" title={path}>
            {dirty && !untitled && <span className="mr-1 text-accent" title="Alterações não salvas">●</span>}
            {name}
            {draft !== null && !untitled && <span className="ml-2 text-[11px] font-normal text-text-3">editando</span>}
            {untitled && (
              <span className="ml-2 text-[11px] font-normal text-text-3">
                {noteId && draft === savedText ? "salva em Notas" : draft && draft.trim() ? "salva sozinha em Notas…" : "nota nova"}
              </span>
            )}
          </div>
          <IconButton
            label={notesOpen ? "Esconder a lista de notas" : "Mostrar a lista de notas"}
            active={notesOpen}
            onClick={() =>
              setNotesOpen((v) => {
                savePref(PREF_NOTES, !v);
                return !v;
              })
            }
          >
            <NotebookText size={15} />
          </IconButton>
          <IconButton label="Encostar na esquerda (altura toda)" onClick={() => dock("left")}>
            <PanelLeft size={15} />
          </IconButton>
          <IconButton label="Encostar na direita (altura toda)" onClick={() => dock("right")}>
            <PanelRight size={15} />
          </IconButton>
          <IconButton label={maximized ? "Restaurar o tamanho do painel" : "Maximizar o painel"} onClick={() => setMaximized((m) => !m)}>
            {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </IconButton>
          <IconButton label="Fechar (Esc)" onClick={requestClose}>
            <X size={16} />
          </IconButton>
        </div>

        <div className="flex min-h-0 flex-1">
        {notesOpen && (
          <div className="flex w-[190px] shrink-0 flex-col border-r border-border bg-bg-panel">
            <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-text-1">Notas</span>
              <IconButton label="Nova nota em branco" onClick={() => void newNote()}>
                <Plus size={14} />
              </IconButton>
            </div>
            <div className="min-h-0 flex-1 overflow-auto py-1">
              {notes.length === 0 && (
                <div className="px-3 py-2 text-[11px] text-text-3">
                  Nenhuma nota ainda. O que você escrever em “Novo arquivo” é salvo aqui sozinho, com data e hora.
                </div>
              )}
              {notes.map((n) => {
                const active = untitled && n.id === noteId;
                return (
                  <div key={n.id} className={cn("group relative px-2 py-1", active ? "bg-accent-soft" : "hover:bg-bg-hover")}>
                    {askDelete === n.id ? (
                      <div className="flex flex-col gap-1 text-[11px] text-text-1">
                        <span>Apagar esta nota?</span>
                        <div className="flex gap-1">
                          <button className="rounded bg-[#DC2626] px-2 py-0.5 font-semibold text-white hover:bg-[#B91C1C]" onClick={() => void deleteNote(n.id)}>
                            Apagar
                          </button>
                          <button className="rounded px-2 py-0.5 ring-1 ring-border hover:bg-bg-hover" onClick={() => setAskDelete(null)}>
                            Não
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <button className="block w-full text-left" title={`${n.title}\n${noteWhen(n.at)}`} onClick={() => void openNote(n.id)}>
                          <div className="truncate pr-5 text-[12px] text-text-1">{n.title}</div>
                          <div className="font-mono text-[10px] text-text-3">{noteWhen(n.at)}</div>
                        </button>
                        <button
                          className="absolute right-1 top-1 hidden rounded p-1 text-text-3 hover:bg-bg-card hover:text-status-err group-hover:block"
                          title="Apagar esta nota"
                          onClick={() => setAskDelete(n.id)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* ações */}
        <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border px-2 py-1">
          {kind !== "image" && (
            <>
              <IconButton
                label={
                  !canEdit && doc.phase === "text"
                    ? "Arquivo grande demais para editar aqui (use o editor padrão)"
                    : draft !== null
                      ? "Parar de editar"
                      : "Editar este arquivo"
                }
                onClick={draft !== null ? stopEdit : startEdit}
                active={draft !== null}
                disabled={!canEdit}
              >
                <Pencil size={15} />
              </IconButton>
              {draft !== null && (
                <button
                  className="mx-1 flex h-7 items-center gap-1 rounded bg-accent px-2 text-[12px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                  title="Gravar no próprio arquivo (Ctrl+S)"
                  onClick={() => void save()}
                  disabled={!dirty || saving}
                >
                  <Save size={14} />
                  {saving ? "Salvando…" : "Salvar"}
                </button>
              )}
              <Sep />
              <IconButton label="Copiar tudo (o conteúdo original do arquivo)" onClick={() => void copyAll()} disabled={!isText}>
                <Copy size={15} />
              </IconButton>
              <IconButton label={hasSel ? "Copiar a seleção" : "Copiar a seleção (selecione um trecho primeiro)"} onClick={() => void copySelection()} disabled={!hasSel}>
                <ClipboardCopy size={15} />
              </IconButton>
              <IconButton label="Selecionar tudo no painel (Ctrl+A)" onClick={selectAll} disabled={!isText}>
                <TextSelect size={15} />
              </IconButton>
              <Sep />
            </>
          )}
          {onNewFile && !untitled && (
            <IconButton label="Novo arquivo de texto nesta pasta" onClick={() => onNewFile(path.replace(/[\\/][^\\/]*$/, ""))}>
              <FilePlus size={15} />
            </IconButton>
          )}
          <IconButton
            label={draft !== null ? "Salvar uma cópia como… (do que está gravado no disco)" : "Salvar uma cópia como… (Ctrl+S)"}
            onClick={() => void saveAs()}
            disabled={doc.phase === "error" || doc.phase === "loading"}
          >
            <FileOutput size={15} />
          </IconButton>
          {!REMOTE && !untitled && (
            <>
              <IconButton label="Abrir com o editor padrão do Windows" onClick={openDefault} disabled={doc.phase === "error" || doc.phase === "loading"}>
                <ExternalLink size={15} />
              </IconButton>
              <IconButton label="Mostrar na pasta (Explorer)" onClick={reveal} disabled={doc.phase === "error" || doc.phase === "loading"}>
                <FolderOpen size={15} />
              </IconButton>
            </>
          )}
          {!untitled && (
            <IconButton label={`Copiar o caminho\n${path}`} onClick={() => void copyPath()}>
              <Link size={15} />
            </IconButton>
          )}
          <Sep />
          {kind !== "image" ? (
            <>
              {markdown && (
                <IconButton
                  label={view === "rendered" ? (draft !== null ? "Ver o fonte (editar)" : "Ver o fonte (Markdown)") : "Ver formatado"}
                  onClick={() => setView((v) => (v === "rendered" ? "source" : "rendered"))}
                  active={view === "source"}
                  disabled={!isText}
                >
                  {view === "rendered" ? <Code size={15} /> : <Eye size={15} />}
                </IconButton>
              )}
              <IconButton label={wrap ? "Quebra de linha: ligada" : "Quebra de linha: desligada"} onClick={toggleWrap} active={wrap}>
                <WrapText size={15} />
              </IconButton>
              <IconButton label="Diminuir a fonte" onClick={() => changeFont(-1)}>
                <AArrowDown size={15} />
              </IconButton>
              <span className="min-w-[30px] text-center font-mono text-[11px] text-text-3">{font}px</span>
              <IconButton label="Aumentar a fonte" onClick={() => changeFont(+1)}>
                <AArrowUp size={15} />
              </IconButton>
            </>
          ) : (
            <>
              <IconButton label="Diminuir o zoom" onClick={() => changeZoom(-1)}>
                <ZoomOut size={15} />
              </IconButton>
              <span className="min-w-[40px] text-center font-mono text-[11px] text-text-3">
                {zoom === "fit" ? "ajustar" : `${Math.round(zoom * 100)}%`}
              </span>
              <IconButton label="Aumentar o zoom" onClick={() => changeZoom(1)}>
                <ZoomIn size={15} />
              </IconButton>
              <IconButton label="Ajustar ao painel" onClick={() => setZoom("fit")} active={zoom === "fit"}>
                <Scan size={15} />
              </IconButton>
              <IconButton label="Tamanho real (100%)" onClick={() => setZoom(1)} active={zoom === 1}>
                <Ratio size={15} />
              </IconButton>
            </>
          )}
        </div>

        {untitled && scratch && !dirty && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-accent-soft px-3 py-1.5 text-[12px] text-text-1">
            <span className="min-w-0 flex-1">Você fechou um texto sem salvar {sinceLabel(new Date(scratch.at).toISOString())}.</span>
            <button
              className="rounded bg-accent px-2 py-0.5 text-white hover:bg-accent-hover"
              onClick={() => {
                setDraft(scratch.text);
                setScratch(null);
                saveScratch(null);
                textareaRef.current?.focus();
              }}
            >
              Recuperar
            </button>
            <button
              className="rounded px-2 py-0.5 ring-1 ring-border hover:bg-bg-hover"
              onClick={() => {
                setScratch(null);
                saveScratch(null);
              }}
            >
              Esquecer
            </button>
          </div>
        )}
        {pending && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-status-warn/15 px-3 py-1.5 text-[12px] text-text-1">
            <span className="min-w-0 flex-1">
              Alterações não salvas em <b>{name}</b>.{" "}
              {pending.kind === "open"
                ? `Abrir ${fileBaseName(pending.path)} assim mesmo?`
                : pending.kind === "close"
                  ? "Fechar assim mesmo?"
                  : "Parar de editar assim mesmo?"}
            </span>
            <button className="rounded bg-accent px-2 py-0.5 text-white hover:bg-accent-hover" onClick={() => void resolvePending("save")}>
              Salvar
            </button>
            <button className="rounded px-2 py-0.5 text-status-err ring-1 ring-border hover:bg-bg-hover" onClick={() => void resolvePending("discard")}>
              Descartar
            </button>
            <button
              className="rounded px-2 py-0.5 ring-1 ring-border hover:bg-bg-hover"
              onClick={() => {
                wantNote.current = null;
                setPending(null);
              }}
            >
              Continuar editando
            </button>
          </div>
        )}
        {conflict && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-status-err/15 px-3 py-1.5 text-[12px] text-text-1">
            <AlertTriangle size={14} className="shrink-0 text-status-err" />
            <span className="min-w-0 flex-1">O arquivo mudou no disco depois que você abriu (outro programa ou agente salvou).</span>
            <button className="rounded bg-accent px-2 py-0.5 text-white hover:bg-accent-hover" onClick={() => void save(true)}>
              Sobrescrever com o meu
            </button>
            <button className="rounded px-2 py-0.5 ring-1 ring-border hover:bg-bg-hover" onClick={reloadFromDisk} title="Descarta o que você editou">
              Recarregar do disco
            </button>
          </div>
        )}

        <div className="relative min-h-0 flex-1 overflow-auto p-3" onClick={onContentClick}>
          {doc.phase === "loading" && <div className="text-text-2">Carregando…</div>}
          {doc.phase === "error" && (
            <div className="flex items-center gap-2 text-status-err">
              <AlertTriangle size={16} className="shrink-0" />
              {doc.message}
            </div>
          )}
          {doc.phase === "image" && (
            <div className={cn("flex min-h-full", zoom === "fit" && "items-center justify-center")}>
              {/* <img>, nunca SVG embutido no DOM: nenhum script de SVG roda */}
              <img
                ref={imgRef}
                src={doc.url}
                alt={name}
                className={zoom === "fit" ? "max-h-full max-w-full object-contain" : "max-w-none"}
                style={zoom !== "fit" && natural ? { width: natural.w * zoom, height: natural.h * zoom } : undefined}
                onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                onError={() => {
                  // a resposta de erro do Go traz a mensagem amigável
                  conn
                    .getBlob(doc.url)
                    .then(() => setDoc({ phase: "error", message: "Não foi possível mostrar a imagem." }))
                    .catch((e: Error) => setDoc({ phase: "error", message: e.message }));
                }}
              />
            </div>
          )}
          {doc.phase === "text" && (
            <>
              {doc.truncated && (
                <div className="mb-2 flex items-center justify-between gap-2 rounded bg-status-warn/15 px-2 py-1 text-[12px] text-status-warn">
                  <span>
                    Arquivo grande ({(doc.size / (1024 * 1024)).toFixed(1)} MB): mostrando só o início. "Salvar como" copia o arquivo inteiro.
                  </span>
                  {!REMOTE && (
                    <button className="shrink-0 rounded bg-accent px-2 py-0.5 text-white hover:bg-accent-hover" onClick={openDefault}>
                      Abrir com o editor padrão
                    </button>
                  )}
                </div>
              )}
              <div
                ref={contentRef}
                className="select-text"
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, editing: e.target instanceof HTMLTextAreaElement });
                }}
              >
                {showSource && draft !== null ? (
                  <textarea
                    ref={textareaRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    spellCheck={false}
                    wrap={wrap ? "soft" : "off"}
                    className="absolute inset-0 h-full w-full resize-none bg-transparent p-3 font-mono text-text-1 outline-none"
                    style={textStyle}
                    aria-label={`Editar ${name}`}
                  />
                ) : showSource ? (
                  <pre
                    className={cn("font-mono text-text-1", wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre")}
                    style={textStyle}
                  >
                    {doc.raw}
                  </pre>
                ) : (
                  <div
                    className={cn("md-view", wrap && "md-wrap")}
                    style={textStyle}
                    // sandbox: renderMarkdownSafe nunca executa <script>, nem
                    // carrega recurso remoto (CSP do app já bloqueia isso)
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                )}
              </div>
            </>
          )}
        </div>

        </div>
        </div>

        {!maximized && (
          <>
            <div className="absolute inset-y-3 left-0 w-1.5 cursor-ew-resize" onPointerDown={startResize("w")} />
            <div className="absolute inset-y-3 right-0 w-1.5 cursor-ew-resize" onPointerDown={startResize("e")} />
            <div className="absolute inset-x-3 top-0 h-1.5 cursor-ns-resize" onPointerDown={startResize("n")} />
            <div className="absolute inset-x-3 bottom-0 h-1.5 cursor-ns-resize" onPointerDown={startResize("s")} />
            <div className="absolute left-0 top-0 h-3 w-3 cursor-nwse-resize" onPointerDown={startResize("nw")} />
            <div className="absolute right-0 top-0 h-3 w-3 cursor-nesw-resize" onPointerDown={startResize("ne")} />
            <div className="absolute bottom-0 left-0 h-3 w-3 cursor-nesw-resize" onPointerDown={startResize("sw")} />
            <div className="absolute bottom-0 right-0 h-3 w-3 cursor-nwse-resize" onPointerDown={startResize("se")} />
          </>
        )}

        {toast && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 max-w-[90%] -translate-x-1/2 truncate rounded bg-bg-body px-3 py-1.5 text-[12px] text-text-1 shadow-lg ring-1 ring-border">
            {toast}
          </div>
        )}
      </div>

      {menu && (
        <div
          className="pointer-events-auto fixed z-[60] min-w-[200px] rounded-md border border-border-strong bg-bg-card py-1 shadow-xl"
          style={{ left: Math.min(menu.x, window.innerWidth - 210), top: Math.min(menu.y, window.innerHeight - 170) }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {menu.editing ? (
            <>
              <MenuItem icon={<Scissors size={14} />} label="Recortar" onClick={() => (setMenu(null), void editCut())} />
              <MenuItem icon={<Copy size={14} />} label="Copiar" onClick={() => (setMenu(null), void editCopy())} />
              <MenuItem icon={<ClipboardPaste size={14} />} label="Colar" onClick={() => (setMenu(null), void editPaste())} />
            </>
          ) : (
            <MenuItem icon={<Copy size={14} />} label={hasSel ? "Copiar seleção" : "Copiar tudo"} onClick={() => (setMenu(null), void (hasSel ? copySelection() : copyAll()))} />
          )}
          <MenuItem icon={<TextSelect size={14} />} label="Selecionar tudo" onClick={() => (setMenu(null), selectAll())} />
          <MenuItem icon={<Link size={14} />} label="Copiar caminho" onClick={() => (setMenu(null), void copyPath())} />
          <MenuItem icon={<FileOutput size={14} />} label="Salvar uma cópia como…" onClick={() => (setMenu(null), void saveAs())} />
        </div>
      )}
    </div>
  );
}

function Sep() {
  return <span className="mx-1 h-4 w-px bg-border-strong" />;
}

function MenuItem({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-text-1 hover:bg-bg-hover" onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}
