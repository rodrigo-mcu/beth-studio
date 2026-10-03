import { download, downloadName, isRemote } from "@/lib/remote";
import { useCallback, useEffect, useRef, useState, type DragEvent as RDragEvent, type ReactNode } from "react";
import { Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import {
  ArrowDownToLine,
  Camera,
  AppWindow,
  ClipboardPaste,
  Copy,
  FolderOpen,
  Grid2x2,
  GripVertical,
  LayoutGrid,
  Maximize2,
  Mic,
  Monitor,
  Palette,
  Power,
  RefreshCw,
  Save,
  ScrollText,
  TextSelect,
  X,
} from "lucide-react";
import type { Connection } from "@/lib/connection";
import type { PaneInfo, ScreenEvent, SettingsEvent } from "@/lib/types";
import { DEFAULT_TERM_THEME, colorsFor, cssFamily, effectiveFor, fontAvailable, resolveFamily, setPane, useCatalog } from "@/lib/appearance";

const DIAG = new URLSearchParams(window.location.search).get("diag") === "1";
const REMOTE = isRemote();
import { AppearancePanel, type Preview } from "./AppearancePanel";
import { paneLabel, shortCwd } from "@/lib/panes";
import { copyText, readClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { IconButton } from "./IconButton";
import { PasteDialog } from "./PasteDialog";
import { ScrollBar } from "./ScrollBar";
import { screenWrite } from "@/lib/screen";
import { openExternal } from "@/lib/links";
import type { PaneLinkCtx } from "@/lib/localFile";
import { markScreen } from "@/lib/startup";
import { lineFallbackLinks, routeTermLink, type CellLike } from "@/lib/termLinks";
import { reasonLabel, type AgentInfo } from "@/lib/agents";
import { IMAGE_TYPES, filesFromTransfer, planUpload, uploadURL } from "@/lib/pasteMedia";
import { PANE_MIME } from "@/lib/dnd";
import { fixedFontFor, fontSizeLabel, nextFontSize, smallGridHint } from "@/lib/fontStep";
import { FitGovernor, effectiveSizeMode, fontForWidth, gridFor, resizeRefusedPane } from "@/lib/hostFit";
import { KindIcon } from "./KindIcon";
import { sftpApi } from "@/lib/sshApi";
import { registerTerm } from "@/lib/termFocus";
import { ZONE_ICON } from "./SplitShellMenu";
import { SPLIT_ZONES, ZONE_LABEL, type SplitZone } from "@/lib/splitSpawn";

// Teclado so' e' repassado se houve uma tecla de verdade ha' pouco: assim
// nenhuma resposta automatica do xterm.js vira entrada no pane do host.
const USER_INPUT_WINDOW_MS = 1500;

// so' o primeiro clique num hyperlink OSC 8 vai para o log (ver linkHandler)
let osc8Logged = false;

interface Props {
  conn: Connection;
  paneId: number;
  pane: PaneInfo | undefined;
  listLoaded: boolean;
  readOnly: boolean;
  settings: SettingsEvent | null;
  focused: boolean;
  canClose: boolean;
  onFocus: () => void;
  onClose: () => void;
  /** arrastar pelo cabecalho (organizacao do web) */
  onHeaderDragStart?: (e: RDragEvent) => void;
  onHeaderDragEnd?: () => void;
  /** menu "Organizar" (mover para aba, dividir...) */
  onOrganize?: (x: number, y: number) => void;
  /** abre a confirmacao "Encerrar este terminal?" */
  onAskKill?: () => void;
  /** destaca este terminal numa janela nativa (ausente = remoto/somente leitura) */
  onDetach?: () => void;
  /** abre a confirmacao "Separar no BethTerm?" (pane em split no host) */
  onAskSeparate?: () => void;
  /** "Novo terminal à direita/abaixo/…" (zone ausente = escolher a direcao) */
  onNewSplit?: (zone: SplitZone | undefined, x: number, y: number) => void;
  /** abre o popup "Falar" (microfone) para este terminal */
  onSpeak?: () => void;
  /** abrir este terminal sozinho numa aba (quando nao cabe) */
  onSolo?: () => void;
  /** muda => realce rapido (chegou aqui pela busca) */
  flashKey?: number;
  /** pane sozinho na aba do host (so' assim o web pode redimensiona-lo) */
  aloneInHost?: boolean;
  /** agente aguardando neste terminal (patch 0175) */
  agent?: AgentInfo;
  onDismissAgent?: () => void;
  /** conteudo extra por cima da area (zonas de soltar) */
  overlay?: ReactNode;
  /** clique num caminho de arquivo local (OSC 8 ou solto) na saída do terminal: abre o painel de preview */
  onOpenFile?: (path: string) => void;
}

export function TerminalView({
  conn,
  paneId,
  pane,
  listLoaded,
  readOnly,
  settings,
  focused,
  canClose,
  onFocus,
  onClose,
  onHeaderDragStart,
  onHeaderDragEnd,
  onOrganize,
  onAskKill,
  onDetach,
  onAskSeparate,
  onNewSplit,
  onSpeak,
  onSolo,
  flashKey,
  agent,
  onDismissAgent,
  aloneInHost = false,
  overlay,
  onOpenFile,
}: Props) {
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (!flashKey) return;
    setFlashing(true);
    const t = window.setTimeout(() => setFlashing(false), 1300);
    return () => window.clearTimeout(t);
  }, [flashKey]);
  const catalog = useCatalog();
  const [showLook, setShowLook] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const eff = effectiveFor(settings, paneId);
  const themeId = preview?.themeId ?? eff.themeId;
  // familia escolhida, trocada pela padrao se nao existir no WebView2
  const family = resolveFamily(preview?.family ?? eff.family).used;
  const colors = colorsFor(catalog, themeId);
  const autoFitRef = useRef(true);
  // Modo de tamanho: "fit" ajusta o pane do host a' area; "host" espelha.
  const sizeMode0 = effectiveSizeMode(settings?.panes?.[String(paneId)]?.size_mode || settings?.default?.size_mode, aloneInHost);
  const sizeModeRef = useRef(sizeMode0);
  const governorRef = useRef(new FitGovernor());
  const hostFitRef = useRef<(reason: "area" | "font" | "open" | "manual" | "auto") => void>(() => {});
  const [divergent, setDivergent] = useState(false);
  const [fighting, setFighting] = useState(false);
  const scrollBoxRef = useRef<HTMLDivElement>(null);
  const preferredFontRef = useRef(14);
  // A ponte recusou o resize (o pane divide a aba do host): cai para "Igual ao BethTerm".
  const [refused, setRefused] = useState(false);
  useEffect(() => setRefused(false), [aloneInHost]);
  // tamanho fixo que vale neste pane agora (0 = automatico); ver fixedFontFor
  const paneFont = settings?.panes?.[String(paneId)]?.font_size ?? 0;
  const fixedSizeRef = useRef(0);
  // Studio remoto: nunca muda o tamanho no host (o servidor também recusa).
  const sizeMode = refused || REMOTE ? "host" : sizeMode0;
  sizeModeRef.current = sizeMode;
  const fixedFont = fixedFontFor(sizeMode, paneFont, settings?.default?.font_size ?? 0);
  fixedSizeRef.current = fixedFont;
  useEffect(
    () =>
      conn.onBridgeError((msg) => {
        if (resizeRefusedPane(msg) === paneId) setRefused(true);
      }),
    [conn, paneId],
  );
  const areaRef = useRef<HTMLDivElement>(null);
  const termElRef = useRef<HTMLDivElement>(null);
  const repairViewRef = useRef<() => void>(() => {});
  const termRef = useRef<Terminal | null>(null);
  const lastUserInput = useRef(0);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const fitRef = useRef<() => void>(() => {});
  // Contexto do pane (kind/distro/cwd) para resolver link de arquivo local
  // clicado no terminal (OSC 8 ou solto) — ver lib/localFile.ts.
  const paneCtxRef = useRef<PaneLinkCtx>({});
  paneCtxRef.current = { paneKind: pane?.kind, paneWsl: pane?.wsl, paneDistro: pane?.wsl_distro || pane?.distro, paneCwd: pane?.cwd };
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  // texto cru (com escapes, inclui OSC 8) da última tela recebida, por linha
  // (mesma ordem de screenWrite) — só assim dá pra achar link no terminal,
  // ja' que o xterm nao expõe "esta célula é um link OSC 8" pela API pública.
  const rawRowsRef = useRef<string[]>([]);

  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [gotScreen, setGotScreen] = useState(false);
  const [noFit, setNoFitState] = useState<{
    cols: number;
    rows: number;
  } | null>(null);
  const [noFitHidden, setNoFitHidden] = useState(false);
  const [fileOver, setFileOver] = useState(false);
  const [smallGrid, setSmallGrid] = useState(false);
  const setNoFit = (v: { cols: number; rows: number } | null) => setNoFitState((o) => (o?.cols === v?.cols && o?.rows === v?.rows ? o : v));
  // Rolagem (patch 0171): o que a ponte mostra e quanto historico existe.
  const [scroll, setScroll] = useState({ offset: 0, scrollback: 0, rows: 24 });
  const scrollToRef = useRef<(offset: number) => void>(() => {});
  /** true quando o grid cabe na area (fonte/escala). Evita forcar scrollLeft=0. */
  const fitsRef = useRef(true);
  const termScaleRef = useRef(1);
  // "Falar" e outros popups devolvem o foco a este terminal (lib/termFocus)
  useEffect(
    () =>
      registerTerm(paneId, {
        focus: () => termRef.current?.focus(),
        toEnd: () => scrollToRef.current(0),
      }),
    [paneId],
  );

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 1400);
  }, []);

  // A- / A+: grava so' a fonte DESTE terminal (o padrao geral nao muda).
  const stepFont = useCallback(
    (delta: number) => {
      const next = nextFontSize(fixedSizeRef.current, termRef.current?.options.fontSize ?? 14, delta);
      if (next === fixedSizeRef.current) return;
      fixedSizeRef.current = next;
      setPane(conn, paneId, { font_size: next }).catch((e: Error) => flash(`Erro: ${e.message}`));
    },
    [conn, paneId, flash],
  );
  const stepFontRef = useRef(stepFont);
  stepFontRef.current = stepFont;

  const doCopy = useCallback(async () => {
    const sel = termRef.current?.getSelection() ?? "";
    if (!sel) return;
    flash((await copyText(sel)) ? "Copiado" : "Não foi possível copiar");
  }, [flash]);

  const sendPaste = useCallback(
    (text: string) => {
      if (readOnlyRef.current || !text) return;
      if (!conn.paste(paneId, text)) flash("Sem conexão: texto não enviado");
    },
    [conn, paneId, flash],
  );

  /** Imagem/arquivo: o Go salva (como a GUI) e cola o caminho no pane. */
  const sendFile = useCallback(
    async (file: File) => {
      if (readOnlyRef.current) return;
      const plan = planUpload(file);
      if ("error" in plan) {
        flash(plan.error);
        return;
      }
      try {
        const r = await conn.upload<{ path: string; text: string }>(uploadURL(plan, paneId), file, plan.contentType);
        flash(plan.endpoint === "/api/paste-image" ? `Imagem colada: ${r.path}` : `Cópia salva e colada: ${r.path}`);
      } catch (e) {
        flash(`Não foi possível colar: ${(e as Error).message}`);
      }
    },
    [conn, paneId, flash],
  );
  const sendFileRef = useRef(sendFile);
  sendFileRef.current = sendFile;

  /** Arquivo copiado no Explorer: copia para tmp e cola o caminho. "empty" = nao havia arquivo. */
  const pasteExplorer = useCallback(async (): Promise<"pasted" | "empty" | "error"> => {
    if (REMOTE || readOnlyRef.current) return "empty";
    try {
      const r = await conn.api<{ empty?: boolean; paths?: string[]; note?: string }>(`/api/paste-clipboard?pane_id=${paneId}`, {});
      if (r.empty || !r.paths?.length) return "empty";
      const label = r.paths.length === 1 ? r.paths[0] : r.paths.join(" · ");
      flash(r.note ? `${r.note} ${label}` : `Cópia salva e colada: ${label}`);
      return "pasted";
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 400) {
        flash(`Não foi possível colar: ${(e as Error).message}`);
        return "error";
      }
      return "empty";
    }
  }, [conn, paneId, flash]);
  const pasteExplorerRef = useRef(pasteExplorer);
  pasteExplorerRef.current = pasteExplorer;

  const doPaste = useCallback(async () => {
    if (readOnlyRef.current) return;
    const hit = await pasteExplorer();
    if (hit !== "empty") {
      termRef.current?.focus();
      return;
    }
    // Imagem na area de transferencia (Print Screen, "copiar imagem")?
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const t = it.types.find((x) => IMAGE_TYPES.includes(x));
        if (t) {
          const blob = await it.getType(t);
          await sendFile(new File([blob], "clipboard", { type: t }));
          termRef.current?.focus();
          return;
        }
      }
    } catch {
      /* sem permissao para ler imagens: tenta texto */
    }
    const text = await readClipboard();
    if (text === null) setPasteOpen(true);
    else if (text) sendPaste(text);
    else flash("A área de transferência está vazia");
    termRef.current?.focus();
  }, [sendPaste, sendFile, flash, pasteExplorer]);

  const doCopyHistory = useCallback(async () => {
    try {
      const r = await conn.api<{ text: string }>("/api/pane/scrollback", { pane_id: paneId });
      flash((await copyText(r.text ?? "")) ? "Histórico copiado" : "Não foi possível copiar");
    } catch (e) {
      flash(`Histórico: ${(e as Error).message}`);
    }
  }, [conn, paneId, flash]);

  const doSaveHistory = useCallback(async () => {
    if (REMOTE) {
      try {
        const r = await conn.api<{ text: string }>("/api/pane/scrollback", { pane_id: paneId });
        const url = URL.createObjectURL(new Blob([r.text ?? ""], { type: "text/plain;charset=utf-8" }));
        download(downloadName(pane ? paneLabel(pane) : `pane-${paneId}`, ".txt"), url);
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
        flash("Histórico baixado");
      } catch (e) {
        flash(`Salvar histórico: ${(e as Error).message}`);
      }
      return;
    }
    try {
      const r = await conn.api<{ saved?: string; cancelled?: boolean }>("/api/pane/scrollback/save", {
        pane_id: paneId,
        title: pane ? paneLabel(pane) : `pane-${paneId}`,
      });
      if (r.cancelled) flash("Salvar cancelado");
      else if (r.saved) flash(`Histórico salvo: ${r.saved}`);
    } catch (e) {
      flash(`Salvar histórico: ${(e as Error).message}`);
    }
  }, [conn, paneId, pane, flash]);

  const captureTermPng = useCallback((): string | null => {
    const term = termRef.current;
    const el = termElRef.current;
    if (!term || !el) return null;
    const r = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(r.width * dpr));
    canvas.height = Math.max(1, Math.floor(r.height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.scale(dpr, dpr);
    const bg = (term.options.theme as { background?: string } | undefined)?.background || "#0c0c0c";
    const fg = (term.options.theme as { foreground?: string } | undefined)?.foreground || "#cccccc";
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, r.width, r.height);
    const fontSize = term.options.fontSize || 14;
    ctx.font = `${fontSize}px ${term.options.fontFamily || "monospace"}`;
    ctx.textBaseline = "top";
    ctx.fillStyle = fg;
    const cellH = r.height / Math.max(1, term.rows);
    const buf = term.buffer.active;
    for (let y = 0; y < term.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      let s = "";
      if (line) {
        for (let col = 0; col < term.cols; col++) s += line.getCell(col)?.getChars() || " ";
      }
      ctx.fillText(s.replace(/\s+$/, ""), 2, y * cellH + 1);
    }
    return canvas.toDataURL("image/png");
  }, []);

  const doCopyShot = useCallback(async () => {
    const dataUrl = captureTermPng();
    if (!dataUrl) return flash("Não foi possível capturar");
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      flash("Imagem copiada");
    } catch {
      flash("Não foi possível copiar a imagem");
    }
  }, [captureTermPng, flash]);

  const doSaveShot = useCallback(async () => {
    const dataUrl = captureTermPng();
    if (!dataUrl) return flash("Não foi possível capturar");
    if (REMOTE) {
      download(downloadName(pane ? paneLabel(pane) : `pane-${paneId}`, ".png"), dataUrl);
      flash("Imagem baixada");
      return;
    }
    try {
      const r = await conn.api<{ saved?: string; cancelled?: boolean }>("/api/pane/screenshot/save", {
        png_base64: dataUrl,
        title: pane ? paneLabel(pane) : `pane-${paneId}`,
      });
      if (r.cancelled) flash("Salvar cancelado");
      else if (r.saved) flash(`Imagem salva: ${r.saved}`);
    } catch (e) {
      flash(`Salvar imagem: ${(e as Error).message}`);
    }
  }, [captureTermPng, conn, pane, paneId, flash]);

  const openSftp = useCallback(async () => {
    const id = pane?.ssh_host_id;
    if (!id) {
      flash("Este SSH não está ligado a um host salvo — salve o host em SSH e Serial para abrir o SFTP");
      return;
    }
    try {
      await sftpApi.openWindow(conn, id);
      flash("Janela SFTP aberta");
    } catch (e) {
      flash(`SFTP: ${(e as Error).message}`);
    }
  }, [pane?.ssh_host_id, conn, flash]);

  // Cria o xterm para este pane.
  useEffect(() => {
    const el = termElRef.current!;
    const term = new Terminal({
      cols: pane?.size.cols ?? 80,
      rows: pane?.size.rows ?? 24,
      scrollback: 0,
      fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: 14,
      lineHeight: 1,
      theme: DEFAULT_TERM_THEME,
      // Cor sem contraste com o fundo e' escurecida/clareada pelo xterm. Ex.:
      // o Claude Code manda negrito como SGR 97 (branco brilhante) mesmo com
      // tema claro, e no fundo branco o texto sumia.
      minimumContrastRatio: 3,
      cursorBlink: true,
      allowProposedApi: true,
      rightClickSelectsWord: false,
      // Hyperlink OSC 8 de verdade (o xterm ja' reconhece nativamente): o
      // alvo REAL manda, nao o texto exibido (ver termLinks.ts / lib/links.ts).
      linkHandler: {
        // sem isso o xterm ignora alvos que nao sao http(s) (file://, caminho
        // do WSL...) — routeTermLink decide o que e' clicavel de verdade
        allowNonHttpProtocols: true,
        activate: (_event, uri) => {
          const r = routeTermLink(uri, paneCtxRef.current);
          // o alvo cru do primeiro clique (e todos com ?diag=1) vai para o log
          // do web: e' assim que se ve o que o programa manda de verdade
          if (DIAG || !osc8Logged) {
            osc8Logged = true;
            const c = paneCtxRef.current;
            void conn
              .api("/api/log", {
                msg: `link osc8: alvo=${JSON.stringify(uri)} kind=${c.paneKind ?? ""} wsl=${!!c.paneWsl} distro=${c.paneDistro ?? ""} -> ${r ? `${r.kind} ${r.kind === "http" ? r.url : r.path}` : "não clicável"}`,
              })
              .catch(() => undefined);
          }
          if (r?.kind === "http") void openExternal(conn, r.url);
          else if (r?.kind === "file") onOpenFileRef.current?.(r.path);
        },
      },
    });
    termRef.current = term;
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.open(el);
    // Fallback (sem OSC 8): URL solta (com/sem esquema) ou caminho de
    // arquivo local solto no texto cru da linha — nunca pisa num intervalo
    // ja' coberto por um hyperlink OSC 8 real.
    const linkProvider = term.registerLinkProvider({
      provideLinks(y, callback) {
        const line = term.buffer.active.getLine(y - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        // texto e colunas pelas celulas reais do xterm (caractere largo,
        // emoji...), para o sublinhado cair exatamente sobre o caminho
        const cells: CellLike[] = [];
        for (let x = 0; x < line.length; x++) {
          const c = line.getCell(x);
          if (!c) break;
          cells.push({ chars: c.getChars(), width: c.getWidth() });
        }
        const links = lineFallbackLinks(cells, rawRowsRef.current[y - 1]).flatMap((s) => {
          const r = routeTermLink(s.uri, paneCtxRef.current);
          if (!r) return [];
          return [
            {
              range: { start: { x: s.x1, y }, end: { x: s.x2, y } },
              text: s.uri,
              activate: () => {
                if (r.kind === "http") void openExternal(conn, r.url);
                else onOpenFileRef.current?.(r.path);
              },
            },
          ];
        });
        callback(links.length ? links : undefined);
      },
    });
    setSize({ cols: term.cols, rows: term.rows });

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      const k = ev.key.toLowerCase();
      // Colar: deixa o navegador gerar o evento "paste" (tratado abaixo).
      if ((ev.ctrlKey && !ev.altKey && k === "v") || (ev.shiftKey && ev.key === "Insert")) return false;
      // Copiar: Ctrl+C com selecao, ou Ctrl+Shift+C.
      if (ev.ctrlKey && k === "c" && (ev.shiftKey || term.hasSelection())) {
        void copyText(term.getSelection()).then((ok) => ok && flash("Copiado"));
        term.clearSelection();
        ev.preventDefault();
        return false;
      }
      lastUserInput.current = Date.now();
      return true;
    });

    const markInput = () => {
      lastUserInput.current = Date.now();
    };
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // ATENCAO: o clipboardData e' esvaziado pelo navegador assim que este
      // handler sincrono retorna. Ler texto e arquivos AQUI, antes de qualquer
      // await; depois do await getData() devolve "" e o Ctrl+V nao cola nada
      // (regressao de 2026-10-01, commit abcf4db).
      const data = e.clipboardData;
      const files = data ? filesFromTransfer(data).slice(0, 8) : [];
      const text = data?.getData("text/plain") ?? "";
      void (async () => {
        const hit = await pasteExplorerRef.current();
        if (hit !== "empty") return;
        if (files.length) {
          for (const f of files) await sendFileRef.current(f);
          return;
        }
        sendPaste(text);
      })();
    };
    el.addEventListener("compositionend", markInput, true);
    el.addEventListener("paste", onPaste, true);

    // --- rolagem -----------------------------------------------------
    // A roda pede `scroll` a ponte (3 linhas por "clique", deltas
    // acumulados, no maximo 1 envio a cada 30 ms). Vale tambem para apps
    // com mouse reporting / tela alternativa: sempre rola o historico.
    const cur = { offset: 0, scrollback: 0, rows: term.rows };
    let desired: number | null = null; // pedido ainda nao confirmado
    let lastSent = -1;
    let lastSentAt = 0;
    let timer: number | undefined;
    let wheelAcc = 0;
    const flush = () => {
      timer = undefined;
      if (desired === null || desired === lastSent) return;
      lastSent = desired;
      lastSentAt = Date.now();
      conn.scroll(paneId, desired);
    };
    const scrollTo = (o: number) => {
      const max = cur.scrollback > 0 ? cur.scrollback : 1_000_000;
      desired = Math.max(0, Math.min(max, Math.round(o)));
      if (timer === undefined) timer = window.setTimeout(flush, Math.max(0, 30 - (Date.now() - lastSentAt)));
    };
    scrollToRef.current = scrollTo;
    const LINE_PX = 100 / 3; // um "clique" da roda (100 px) = 3 linhas
    let zoomAt = 0;
    const onWheel = (e: WheelEvent) => {
      // Listas do painel Aparencia rolam normalmente.
      if ((e.target as Element | null)?.closest?.("[data-own-wheel]")) return;
      e.preventDefault();
      e.stopPropagation();
      // Ctrl + roda = tamanho da fonte deste terminal (no maximo ~8 passos/s).
      if (e.ctrlKey) {
        if (e.deltaY !== 0 && Date.now() - zoomAt > 120) {
          zoomAt = Date.now();
          stepFontRef.current(e.deltaY < 0 ? +1 : -1);
        }
        return;
      }
      const px = e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaMode === 2 ? e.deltaY * cur.rows * LINE_PX : e.deltaY;
      wheelAcc += px;
      const lines = Math.trunc(wheelAcc / LINE_PX);
      if (!lines) return;
      wheelAcc -= lines * LINE_PX;
      scrollTo((desired ?? cur.offset) - lines);
    };
    const area = areaRef.current!;
    area.addEventListener("wheel", onWheel, { capture: true, passive: false });

    const dataSub = term.onData((d) => {
      if (readOnlyRef.current) return;
      if (Date.now() - lastUserInput.current > USER_INPUT_WINDOW_MS) return;
      // Digitar volta ao fim (a ponte faz isso sozinha no send).
      desired = null;
      lastSent = 0;
      conn.send(paneId, d);
    });
    const selSub = term.onSelectionChange(() => setHasSelection(term.hasSelection()));

    // Ajuste da fonte ao grid cols x rows do host. Converge medindo o
    // .xterm-screen real; se passar da area, reduz mais 0,5 px (e nao volta
    // a crescer nesta rodada). No minimo (5 px) e ainda sem caber: escala
    // CSS o terminal para caber (sem cortar a direita) e libera scroll.
    const MIN_FONT = 5;
    const MAX_FONT = 28;
    let raf = 0;
    let steps = 0;
    let shrunk = false;
    const step = () => {
      raf = 0;
      const area = areaRef.current;
      const screen = el.querySelector(".xterm-screen") as HTMLElement | null;
      if (!area || !screen) return;
      const aw = area.clientWidth - 12;
      const ah = area.clientHeight - 12;
      // Mede o tamanho natural (sem escala CSS).
      const prevScale = termScaleRef.current;
      if (prevScale !== 1) {
        el.style.transform = "";
        termScaleRef.current = 1;
      }
      const sw = screen.offsetWidth;
      const sh = screen.offsetHeight;
      if (aw <= 0 || ah <= 0 || !sw || !sh) return;
      const cur = term.options.fontSize ?? 14;
      let fits = sw <= aw && sh <= ah;
      if (!autoFitRef.current && steps < 24) {
        // Fonte fixa / "Ajustar": nunca um grid mais largo que a area. Se o
        // tamanho do host nao cabe (a GUI mudou, ou fonte fixa grande),
        // reduz a fonte so' enquanto nao cabe; volta a' preferida depois.
        const next = fontForWidth(preferredFontRef.current, cur, sw, aw);
        if (next !== cur) {
          steps++;
          term.options.fontSize = next;
          raf = requestAnimationFrame(step);
          return;
        }
      }
      if (autoFitRef.current && steps < 24) {
        let next = Math.floor(cur * Math.min(aw / sw, ah / sh) * 2) / 2;
        if (!fits && next >= cur) next = cur - 0.5;
        if (fits && shrunk && next > cur) next = cur;
        next = Math.max(MIN_FONT, Math.min(MAX_FONT, next));
        if (next !== cur) {
          if (next < cur) shrunk = true;
          steps++;
          term.options.fontSize = next;
          raf = requestAnimationFrame(step);
          return;
        }
      }
      // Fonte no minimo e ainda nao cabe: escala o xterm para a area.
      let scale = 1;
      const sw2 = screen.offsetWidth;
      const sh2 = screen.offsetHeight;
      fits = sw2 <= aw && sh2 <= ah;
      if (!fits && sw2 > 0 && sh2 > 0) {
        scale = Math.min(aw / sw2, ah / sh2, 1);
        if (scale < 0.99) {
          el.style.transform = `scale(${scale})`;
          el.style.transformOrigin = "left top";
          termScaleRef.current = scale;
          fits = true; // cabe apos escala; nao precisa scroll horizontal
        } else {
          el.style.transform = "";
          termScaleRef.current = 1;
        }
      } else {
        el.style.transform = "";
        termScaleRef.current = 1;
      }
      fitsRef.current = fits || scale < 1;
      setNoFit(!fits && scale >= 1 ? { cols: term.cols, rows: term.rows } : null);
      setSmallGrid(smallGridHint(autoFitRef.current ? 0 : preferredFontRef.current, sw2, sh2, aw, ah));
    };
    const fit = () => {
      steps = 0;
      shrunk = false;
      if (!raf) raf = requestAnimationFrame(step);
    };
    fitRef.current = fit;

    // "Ajustar a' janela": cols x rows = area / celula real do xterm.
    const PAD = 6;
    let hostTimer: number | undefined;
    const hostFitNow = (reason: "area" | "font" | "open" | "manual" | "auto") => {
      if (sizeModeRef.current !== "fit" || readOnlyRef.current) return;
      const areaEl = areaRef.current;
      const scr = el.querySelector(".xterm-screen") as HTMLElement | null;
      if (!areaEl || !scr || !term.cols || !term.rows || !scr.offsetWidth) return;
      const want = gridFor(
        areaEl.clientWidth - 2 * PAD - 14, // 14 = barra de rolagem do historico
        areaEl.clientHeight - 2 * PAD,
        // celula na fonte PREFERIDA (a atual pode estar reduzida so' para caber)
        ((scr.offsetWidth / term.cols) * preferredFontRef.current) / (term.options.fontSize ?? preferredFontRef.current),
        ((scr.offsetHeight / term.rows) * preferredFontRef.current) / (term.options.fontSize ?? preferredFontRef.current),
      );
      if (!want) return;
      const send = governorRef.current.request(want, { cols: term.cols, rows: term.rows }, reason, Date.now());
      if (send) conn.resize(paneId, send.cols, send.rows);
      setDivergent(governorRef.current.divergent);
    };
    const hostFit = (reason: "area" | "font" | "open" | "manual" | "auto") => {
      window.clearTimeout(hostTimer);
      hostTimer = window.setTimeout(() => requestAnimationFrame(() => hostFitNow(reason)), reason === "manual" ? 0 : 150);
    };
    hostFitRef.current = hostFit;
    let opened = false;

    const ro = new ResizeObserver(() => {
      fit();
      hostFit("area");
    });
    ro.observe(areaRef.current!);
    fit();

    // Full-screen apps can produce frames faster than xterm.js parses them.
    // Keep only the newest complete snapshot while one write is in flight.
    // This also lets the toolbar rebuild the browser view without sending
    // reset, clear or resize commands to the host or the running application.
    let latestScreen: ScreenEvent | null = null;
    let lastScreen: ScreenEvent | null = null;
    let writing = false;
    let repairPending = false;
    let disposed = false;
    const pumpScreen = () => {
      if (disposed || writing) return;
      if (repairPending) {
        term.reset();
        repairPending = false;
      }
      const next = latestScreen;
      if (!next) return;
      latestScreen = null;
      writing = true;
      term.write(screenWrite(next), () => {
        writing = false;
        pumpScreen();
      });
    };
    repairViewRef.current = () => {
      if (!lastScreen) return;
      repairPending = true;
      latestScreen = lastScreen;
      pumpScreen();
      conn.refreshScreen(paneId);
    };

    const unsub = conn.onScreen(paneId, (ev) => {
      if (term.cols !== ev.cols || term.rows !== ev.rows) {
        term.resize(ev.cols, ev.rows);
        setSize({ cols: ev.cols, rows: ev.rows });
        fit();
      }
      // O host mudou o tamanho por conta propria? Nao reenvia (anti-briga).
      const gov = governorRef.current;
      gov.hostSize({ cols: ev.cols, rows: ev.rows }, Date.now());
      // Com o web em foco, reajusta sozinho (1x a cada 3 s; 3x em 30 s = briga
      // com a GUI: para e mostra o botao).
      if (sizeModeRef.current === "fit" && gov.divergent && gov.autoRefit(Date.now(), document.hasFocus())) hostFit("auto");
      setDivergent(sizeModeRef.current === "fit" && gov.divergent);
      setFighting(gov.fighting);
      if (!opened) {
        opened = true;
        hostFit("open");
      }
      const off = ev.offset ?? 0;
      const sb = ev.scrollback ?? 0;
      if (desired !== null && desired === off && timer === undefined) desired = null;
      if (off !== cur.offset || sb !== cur.scrollback || ev.rows !== cur.rows) {
        cur.offset = off;
        cur.scrollback = sb;
        cur.rows = ev.rows;
        setScroll({ offset: off, scrollback: sb, rows: ev.rows });
      }
      rawRowsRef.current = ev.text.split("\r\n");
      lastScreen = ev;
      latestScreen = ev;
      pumpScreen();
      // So' recentra horizontalmente quando o grid cabe. Se nao cabe, manter
      // scrollLeft deixa ver a direita (antes zerava a cada frame e cortava).
      if (fitsRef.current && scrollBoxRef.current && scrollBoxRef.current.scrollLeft !== 0) {
        scrollBoxRef.current.scrollLeft = 0;
      }
      setGotScreen(true);
      markScreen(paneId); // tela de abertura: este terminal já apareceu
    });

    return () => {
      disposed = true;
      repairViewRef.current = () => {};
      unsub();
      window.clearTimeout(timer);
      window.clearTimeout(hostTimer);
      area.removeEventListener("wheel", onWheel, true);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener("compositionend", markInput, true);
      el.removeEventListener("paste", onPaste, true);
      dataSub.dispose();
      selSub.dispose();
      linkProvider.dispose();
      term.dispose();
      termRef.current = null;
    };
    // pane muda a cada `list`; so' o id recria o terminal.
  }, [conn, paneId]);

  // Tema / fonte / tamanho (configuracao salva ou pre-visualizacao).
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = colors;
    term.options.fontFamily = cssFamily(family);
    // peso: a GUI usa font_bold do default-theme.json; o web herda (ou o do pane)
    term.options.fontWeight = eff.bold ? "bold" : "normal";
    term.options.fontWeightBold = eff.bold ? "800" : "bold";
    // Garante a fonte carregada e remede a celula (senao o xterm pode medir
    // com a reserva e ficar com ela).
    let alive = true;
    void document.fonts
      .load(`${term.options.fontSize ?? 14}px "${family.replace(/"/g, "")}"`)
      .then(() => {
        if (!alive || termRef.current !== term) return;
        const css = cssFamily(family);
        term.options.fontFamily = "monospace";
        term.options.fontFamily = css;
        term.refresh(0, term.rows - 1);
        fitRef.current();
      })
      .catch(() => undefined);
    if (sizeMode === "fit") {
      // o grid se ajusta a' fonte (e nao o contrario)
      autoFitRef.current = false;
      preferredFontRef.current = fixedFont;
      term.options.fontSize = preferredFontRef.current;
    } else if (fixedFont > 0) {
      autoFitRef.current = false;
      preferredFontRef.current = fixedFont;
      term.options.fontSize = fixedFont;
    } else {
      autoFitRef.current = true;
    }
    fitRef.current();
    hostFitRef.current("font");
    if (DIAG) {
      const t = window.setTimeout(() => {
        const el = termElRef.current;
        const rows = el?.querySelector(".xterm-rows") as HTMLElement | null;
        const scr = el?.querySelector(".xterm-screen") as HTMLElement | null;
        const cs = rows ? getComputedStyle(rows) : null;
        const ctx = document.createElement("canvas").getContext("2d");
        const mw = (f: string) => {
          if (!ctx) return 0;
          ctx.font = f;
          return Math.round(ctx.measureText("rl0g@iIl1WWmm").width * 100) / 100;
        };
        void conn
          .api("/api/diag", {
            pane: paneId,
            chosen: eff.family,
            used: family,
            optionFontFamily: term.options.fontFamily,
            fontSize: term.options.fontSize,
            fontWeight: term.options.fontWeight,
            bold: eff.bold,
            computedFamily: cs?.fontFamily,
            computedWeight: cs?.fontWeight,
            domRenderer: !!rows,
            canvases: el?.querySelectorAll("canvas").length,
            check_jb: document.fonts.check('17px "JetBrains Mono"'),
            avail_jb: fontAvailable("JetBrains Mono"),
            avail_casc: fontAvailable("Cascadia Mono"),
            avail_fake: fontAvailable("Fonte Que Nao Existe"),
            w_jb: mw('32px "JetBrains Mono"'),
            w_casc: mw('32px "Cascadia Mono"'),
            w_consolas: mw("32px Consolas"),
            w_monospace: mw("32px monospace"),
            cell: scr && term.cols ? Math.round((scr.offsetWidth / term.cols) * 100) / 100 : 0,
          })
          .catch(() => undefined);
      }, 1500);
      return () => {
        alive = false;
        window.clearTimeout(t);
      };
    }
    return () => {
      alive = false;
    };
  }, [colors, family, fixedFont, paneId, sizeMode, eff.bold]);

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

  const gone = listLoaded && !pane;
  const title = pane ? paneLabel(pane) : `Terminal ${paneId}`;
  const cwd = pane ? shortCwd(pane.cwd, 4) : "";

  return (
    <section
      className={cn(
        "flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border bg-bg-panel",
        focused ? "border-accent" : "border-border",
        flashing && "animate-bt-flash",
      )}
      onMouseDownCapture={onFocus}
      onFocusCapture={onFocus}
    >
      <header
        className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2"
        onContextMenu={(e) => {
          if (!onOrganize) return;
          e.preventDefault();
          onOrganize(e.clientX, e.clientY);
        }}
      >
        <div
          className={cn("flex min-w-[56px] flex-1 items-center gap-1.5", onHeaderDragStart && "cursor-grab active:cursor-grabbing")}
          draggable={!!onHeaderDragStart}
          onDragStart={onHeaderDragStart}
          onDragEnd={onHeaderDragEnd}
          title={
            onHeaderDragStart
              ? `${title}
Arraste para outra aba ou para a borda de outro terminal`
              : title
          }
        >
          {onHeaderDragStart && <GripVertical size={14} className="shrink-0 text-text-3" />}
          {pane && <KindIcon pane={pane} />}
          <div className="min-w-0 truncate text-[13px] font-semibold text-text-1">{title}</div>
          {cwd && <div className="hidden min-w-0 shrink-[2] truncate font-mono text-[11px] text-text-3 xl:block">{cwd}</div>}
        </div>
        {agent && (
          <span
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-status-warn/15 py-0.5 pl-2 pr-0.5 text-[11px] font-semibold text-status-warn ring-1 ring-status-warn/40"
            title={`Agente aguardando resposta (${reasonLabel(agent)}). Digitar no terminal limpa o aviso.`}
          >
            <span className="relative inline-flex h-2 w-2">
              <span className="absolute inset-0 animate-ping rounded-full bg-status-warn opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-status-warn" />
            </span>
            aguardando
            {onDismissAgent && (
              <button className="rounded-full p-0.5 hover:bg-status-warn/20" title="Dispensar aviso" onClick={onDismissAgent}>
                <X size={11} />
              </button>
            )}
          </span>
        )}
        {size && (
          <span
            className="shrink-0 rounded bg-bg-card px-1.5 py-0.5 font-mono text-[11px] text-text-2"
            title="Tamanho do pane no BethTerm (colunas × linhas)"
          >
            {size.cols}×{size.rows}
          </span>
        )}
        <div
          className="flex shrink-0 items-center rounded border border-border"
          title="Tamanho da fonte deste terminal (Ctrl + roda do mouse também)"
        >
          <button
            className="px-1.5 py-0.5 text-[11px] font-semibold text-text-2 hover:bg-bg-hover hover:text-text-1"
            title="Diminuir a fonte (A−)"
            onClick={() => stepFont(-1)}
          >
            A−
          </button>
          <button
            className={cn(
              "min-w-[38px] border-x border-border px-1 py-0.5 font-mono text-[11px] hover:bg-bg-hover",
              fixedFont ? "text-text-1" : "text-text-3",
            )}
            title={
              sizeMode === "fit"
                ? "Tamanho da fonte (o terminal se ajusta à janela)"
                : fixedFont
                  ? "Tamanho fixo — clique para voltar ao automático (ajustar à área)"
                  : "Automático (ajusta à área)"
            }
            onClick={() => paneFont > 0 && setPane(conn, paneId, { font_size: 0 }).catch((e: Error) => flash(`Erro: ${e.message}`))}
          >
            {fontSizeLabel(fixedFont)}
          </button>
          <button
            className="px-1.5 py-0.5 text-[11px] font-semibold text-text-2 hover:bg-bg-hover hover:text-text-1"
            title="Aumentar a fonte (A+)"
            onClick={() => stepFont(+1)}
          >
            A+
          </button>
        </div>
        {!REMOTE && (
        <div className="flex shrink-0 items-center overflow-hidden rounded border border-border">
          <button
            className={cn(
              "px-1 py-0.5 hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-40",
              sizeMode === "fit" ? "bg-accent-soft text-accent-text" : "text-text-2",
            )}
            disabled={readOnly || (!aloneInHost && !onAskSeparate)}
            title={
              !aloneInHost
                ? "Este terminal está num split no BethTerm. Clique para separá-lo numa aba própria (na mesma janela) e então ajustar à janela."
                : readOnly
                  ? "Ajustar à janela: indisponível em somente leitura"
                  : "Ajustar à janela: o terminal (também no BethTerm) muda de colunas×linhas para caber aqui"
            }
            onClick={() =>
              !aloneInHost ? onAskSeparate?.() : setPane(conn, paneId, { size_mode: "fit" }).catch((e: Error) => flash(`Erro: ${e.message}`))
            }
          >
            <Maximize2 size={13} />
          </button>
          <button
            className={cn(
              "border-l border-border px-1 py-0.5 hover:bg-bg-hover",
              sizeMode === "host" ? "bg-accent-soft text-accent-text" : "text-text-2",
            )}
            title="Igual ao BethTerm: mostra o tamanho que o terminal tem lá (a fonte se ajusta)"
            onClick={() => aloneInHost && setPane(conn, paneId, { size_mode: "host" }).catch((e: Error) => flash(`Erro: ${e.message}`))}
          >
            <Monitor size={13} />
          </button>
        </div>
        )}
        {onNewSplit && !readOnly && (
          <IconButton
            label="Dividir: abrir mais um terminal à direita, abaixo, acima ou à esquerda"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onNewSplit(undefined, r.left, r.bottom + 2);
            }}
          >
            <Grid2x2 size={15} />
          </IconButton>
        )}
        {onSpeak && !readOnly && (
          <IconButton label="Falar (microfone): ditar um texto para este terminal" onClick={onSpeak}>
            <Mic size={15} />
          </IconButton>
        )}
        {pane?.kind === "ssh" && (
          <IconButton
            label={
              pane.ssh_host_id
                ? "Abrir transferência de arquivos (SFTP) numa janela separada"
                : "SFTP: este terminal SSH não está ligado a um host salvo"
            }
            onClick={() => void openSftp()}
            disabled={!pane.ssh_host_id}
          >
            <FolderOpen size={15} />
          </IconButton>
        )}
        <IconButton label="Aparência: tema, fonte e tamanho" onClick={() => {
            // fechar pelo botao tambem descarta a pre-visualizacao (senao o
            // tema so' de passar o mouse ficava na tela ate' trocar de aba)
            if (showLook) setPreview(null);
            setShowLook(!showLook);
          }}
          active={showLook}
        >
          <Palette size={15} />
        </IconButton>
        <IconButton
          label="Reparar visualização: reconstrói só a tela deste painel, sem interromper o aplicativo"
          onClick={() => repairViewRef.current()}
          disabled={!gotScreen}
        >
          <RefreshCw size={15} />
        </IconButton>
        <IconButton label="Copiar seleção" onClick={doCopy} disabled={!hasSelection}>
          <Copy size={15} />
        </IconButton>
        <IconButton label={readOnly ? "Colar (desabilitado: somente leitura)" : "Colar no terminal"} onClick={doPaste} disabled={readOnly || gone}>
          <ClipboardPaste size={15} />
        </IconButton>
        {onDetach && (
          <IconButton label="Destacar em janela (o terminal continua rodando)" onClick={onDetach}>
            <AppWindow size={15} />
          </IconButton>
        )}
        {canClose && (
          <IconButton label="Fechar visualização (o terminal continua rodando)" onClick={onClose}>
            <X size={15} />
          </IconButton>
        )}
      </header>

      <div
        ref={areaRef}
        className="relative min-h-0 flex-1 overflow-hidden"
        style={{ background: colors.background }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        onMouseDown={() => {
          // clique no terminal (fora do painel, que para o evento) fecha temas
          if (showLook) {
            setPreview(null);
            setShowLook(false);
          }
        }}
        onDragOver={(e) => {
          // arquivo/imagem vindo do Explorer (nao um terminal arrastado)
          if (!e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes(PANE_MIME) || readOnly) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setFileOver(true);
        }}
        onDragLeave={() => setFileOver(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes(PANE_MIME)) return;
          e.preventDefault();
          setFileOver(false);
          const files = Array.from(e.dataTransfer.files).slice(0, 5);
          void (async () => {
            for (const f of files) await sendFile(f);
          })();
        }}
      >
        {fileOver && (
          <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-md border-2 border-dashed border-accent bg-accent/20">
            <span className="rounded bg-bg-card px-3 py-1.5 text-[12px] text-text-1 shadow">
              Solte para colar: imagem vira PNG como na GUI; outro arquivo vira uma cópia — o caminho vai para o terminal
            </span>
          </div>
        )}
        <div ref={scrollBoxRef} className="absolute inset-0 flex overflow-auto">
          <div ref={termElRef} className="select-text p-1.5" />
        </div>
        {!gotScreen && !gone && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-text-2">Carregando a tela do terminal…</div>
        )}
        {gone && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-bg-body/80 text-text-1">
            <div>Este terminal não existe mais no BethTerm.</div>
            {canClose && (
              <button className="rounded bg-accent px-3 py-1.5 text-white hover:bg-accent-hover" onClick={onClose}>
                Remover daqui
              </button>
            )}
          </div>
        )}
        {scroll.scrollback > 0 && (
          <ScrollBar offset={scroll.offset} scrollback={scroll.scrollback} rows={scroll.rows} onScrollTo={(o) => scrollToRef.current(o)} />
        )}
        {scroll.offset > 0 && (
          <button
            className="absolute bottom-3 right-6 flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-[12px] text-white shadow-lg hover:bg-accent-hover"
            onClick={() => scrollToRef.current(0)}
            title="Voltar para a tela ao vivo"
          >
            <ArrowDownToLine size={14} />
            Voltar ao fim
            <span className="opacity-75">({scroll.offset} linhas acima)</span>
          </button>
        )}
        {scroll.offset > 0 && gotScreen && (
          <div
            className="pointer-events-none absolute left-3 top-2 z-20 max-w-[min(420px,70%)] rounded bg-bg-card/95 px-2 py-1 text-[11px] text-text-2 shadow ring-1 ring-border"
            title="Apps em tela cheia (Claude Code etc.) redesenham a tela; o histórico pode parecer misturado. A vista fica fixa enquanto você rola."
          >
            Histórico de tela cheia pode parecer misturado — use Voltar ao fim para a tela ao vivo
          </div>
        )}
        {showLook && (
          <AppearancePanel
            conn={conn}
            paneId={paneId}
            catalog={catalog}
            settings={settings}
            eff={eff}
            onPreview={setPreview}
            onClose={() => {
              setPreview(null);
              setShowLook(false);
            }}
            onMessage={flash}
          />
        )}
        {smallGrid && gotScreen && paneFont > 0 && sizeMode === "host" && (
          <button
            className="absolute bottom-3 left-3 z-20 rounded bg-bg-card/95 px-2 py-0.5 text-[11px] text-text-2 shadow ring-1 ring-border hover:text-text-1"
            onClick={() => setPane(conn, paneId, { font_size: 0 }).catch((e: Error) => flash(`Erro: ${e.message}`))}
            title="A fonte fixa deixa o terminal pequeno nesta área"
          >
            Clique em {paneFont}px para ajustar à janela
          </button>
        )}
        {divergent && sizeMode === "fit" && gotScreen && (
          <button
            className="absolute right-6 top-2 z-20 rounded bg-bg-card/95 px-2 py-0.5 text-[11px] text-text-1 shadow ring-1 ring-border hover:bg-bg-hover"
            title={
              fighting
                ? "A GUI também está mudando o tamanho deste terminal. Clique para ajustar de novo a esta janela."
                : "O tamanho foi mudado no BethTerm; clique para ajustar de novo a esta janela"
            }
            onClick={() => hostFitRef.current("manual")}
          >
            Reajustar a esta janela
          </button>
        )}
        {noFit && gotScreen && !noFitHidden && sizeMode === "host" && scroll.offset === 0 && (
          <div className="absolute left-2 top-2 z-20 flex items-center gap-1.5 whitespace-nowrap rounded bg-bg-card/95 py-0.5 pl-2 pr-0.5 text-[11px] text-status-warn shadow ring-1 ring-border">
            <span
              title={`${noFit.cols} colunas × ${noFit.rows} linhas não cabem nesta área${
                autoFitRef.current ? " nem com a fonte mínima" : " com o tamanho de fonte fixo escolhido"
              }. Role horizontalmente para ver o resto, ou ajuste à janela.`}
            >
              Não cabe ({noFit.cols}×{noFit.rows})
            </span>
            {aloneInHost && (
              <button
                className="rounded bg-accent px-1.5 py-0.5 text-white hover:bg-accent-hover"
                onClick={() => setPane(conn, paneId, { size_mode: "fit" }).catch((e: Error) => flash(`Erro: ${e.message}`))}
                title="Redimensiona o terminal no host para caber nesta área"
              >
                Ajustar à janela
              </button>
            )}
            {onSolo && (
              <button
                className="rounded bg-accent px-1.5 py-0.5 text-white hover:bg-accent-hover"
                onClick={onSolo}
                title="Abrir este terminal sozinho numa aba nova"
              >
                Abrir sozinho
              </button>
            )}
            <button className="rounded p-0.5 text-text-3 hover:text-text-1" title="Esconder aviso" onClick={() => setNoFitHidden(true)}>
              <X size={12} />
            </button>
          </div>
        )}
        {overlay}
        {toast && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded bg-bg-card px-3 py-1.5 text-text-1 shadow-lg ring-1 ring-border">
            {toast}
          </div>
        )}
      </div>

      {menu && (
        <div
          className="fixed z-50 min-w-[230px] rounded-md border border-border-strong bg-bg-card py-1 shadow-xl"
          style={{
            left: Math.min(menu.x, window.innerWidth - 240),
            top: Math.min(menu.y, window.innerHeight - (onNewSplit && !readOnly ? 420 : 280)),
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {onNewSplit && !readOnly && (
            <>
              {SPLIT_ZONES.map((z) => (
                <MenuItem
                  key={z}
                  icon={ZONE_ICON[z]}
                  label={`${ZONE_LABEL[z]}…`}
                  onClick={() => {
                    const m = menu;
                    setMenu(null);
                    onNewSplit(z, m.x, m.y);
                  }}
                />
              ))}
              <div className="my-1 border-t border-border" />
            </>
          )}
          <MenuItem
            icon={<Copy size={14} />}
            label="Copiar"
            disabled={!hasSelection}
            onClick={() => {
              setMenu(null);
              void doCopy();
            }}
          />
          <MenuItem
            icon={<ClipboardPaste size={14} />}
            label="Colar"
            disabled={readOnly || gone}
            onClick={() => {
              setMenu(null);
              void doPaste();
            }}
          />
          <MenuItem
            icon={<TextSelect size={14} />}
            label="Selecionar tudo"
            onClick={() => {
              setMenu(null);
              termRef.current?.selectAll();
            }}
          />
          <div className="my-1 border-t border-border" />
          <MenuItem
            icon={<ScrollText size={14} />}
            label="Copiar histórico"
            onClick={() => {
              setMenu(null);
              void doCopyHistory();
            }}
          />
          <MenuItem
            icon={<Save size={14} />}
            label="Salvar histórico…"
            onClick={() => {
              setMenu(null);
              void doSaveHistory();
            }}
          />
          <MenuItem
            icon={<Camera size={14} />}
            label="Copiar print do terminal"
            onClick={() => {
              setMenu(null);
              void doCopyShot();
            }}
          />
          <MenuItem
            icon={<Camera size={14} />}
            label="Salvar print…"
            onClick={() => {
              setMenu(null);
              void doSaveShot();
            }}
          />
          {onAskSeparate && !aloneInHost && (
            <MenuItem
              icon={<Maximize2 size={14} />}
              label="Separar no BethTerm para ajustar à janela…"
              onClick={() => {
                setMenu(null);
                onAskSeparate();
              }}
            />
          )}
          {onAskKill && (
            <>
              <div className="my-1 border-t border-border" />
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-status-err hover:bg-status-err/10"
                onClick={() => {
                  setMenu(null);
                  onAskKill();
                }}
              >
                <Power size={14} />
                Encerrar terminal…
              </button>
            </>
          )}
          {onOrganize && (
            <MenuItem
              icon={<LayoutGrid size={14} />}
              label="Organizar este terminal…"
              onClick={() => {
                const m = menu;
                setMenu(null);
                onOrganize(m.x, m.y);
              }}
            />
          )}
        </div>
      )}

      {pasteOpen && (
        <PasteDialog
          onCancel={() => setPasteOpen(false)}
          onSend={(text) => {
            setPasteOpen(false);
            sendPaste(text);
            termRef.current?.focus();
          }}
        />
      )}
    </section>
  );
}

function MenuItem({ icon, label, disabled, onClick }: { icon: ReactNode; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-text-1 hover:bg-bg-hover disabled:cursor-default disabled:text-text-3 disabled:hover:bg-transparent"
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}
