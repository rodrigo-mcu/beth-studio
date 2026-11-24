import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AlertTriangle, Lock, PanelLeftOpen, X } from "lucide-react";
import { WorktreePanel } from "@/components/WorktreePanel";

import { shortCwd } from "@/lib/panes";
import { Connection } from "@/lib/connection";
import { loadCatalog } from "@/lib/appearance";
import type { PaneInfo, SettingsEvent, StatusEvent } from "@/lib/types";
import * as L from "@/lib/layout";
import { beginExternalPaneDrag, dispatchPaneDrag, endDrag, startPaneDrag, useDrag } from "@/lib/dnd";
import { pointInPage, shouldCloseAfterDrop, toCssPoint } from "@/lib/termDrop";
import { Sidebar, type SidebarMode } from "@/components/Sidebar";
import { TerminalView } from "@/components/TerminalView";
import { IconButton } from "@/components/IconButton";
import { TabBar } from "@/components/TabBar";
import { buildStudioActions } from "@/components/StudioActions";
import { HostBanner } from "@/components/HostBanner";
import { hostBanner } from "@/lib/hostBanner";
import { RestoreBanner } from "@/components/RestoreBanner";
import { ResumeBanner } from "@/components/ResumeBanner";
import { AgentProcsBell } from "@/components/AgentProcsBanner";
import { CpuLimitButton } from "@/components/CpuLimitButton";
import { restoreBanner } from "@/lib/restoreBanner";
import { GoneLeaf, SplitView } from "@/components/SplitView";
import { PaneMenu, type PaneMenuActions } from "@/components/PaneMenu";
import { SearchPalette } from "@/components/SearchPalette";
import { TerminalGrid } from "@/components/TerminalGrid";
import type { ResultActions } from "@/components/SearchResults";
import { useSearch } from "@/lib/useSearch";
import { SettingsDialog, type SettingsSection } from "@/components/SettingsDialog";
import { NewTerminalDialog } from "@/components/NewTerminalDialog";
import { EmptyTabBoard } from "@/components/EmptyTabBoard";
import { SplitShellMenu } from "@/components/SplitShellMenu";
import { TaskManager } from "@/components/TaskManager";
import { FilePreviewPanel } from "@/components/FilePreviewPanel";
import { FolderBrowser, type FolderBrowserMode } from "@/components/FolderBrowser";
import { UNTITLED_PATH } from "@/lib/folderBrowser";
import { StartupOverlay } from "@/components/StartupOverlay";
import { resolveLinkPath } from "@/lib/localFile";
import { paneFolder } from "@/lib/worktree";
import { nativeGlassPlates, toggleFolderPanel } from "@/lib/sidebarFrame";
import { shellVibrancyOn } from "@/lib/appearanceTune";
import { installLinkGuard } from "@/lib/links";
import { SshScreen, type ToolKind } from "@/components/SshScreen";
import { TopResizeEdges } from "@/components/WindowControls";
import { AppTitle } from "@/components/AppTitle";
import { TooltipLayer } from "@/components/TooltipLayer";
import { dragMacWindow, isMacTitlebar, useWindowState, zoomMacWindow } from "@/lib/windowFrame";
import { isRemote, openRemoteTab } from "@/lib/remote";
import { RemoteConnectedBadge } from "@/components/RemoteStudioSection";
import { returnFocus, withTabFocus } from "@/lib/termFocus";
import { sameShellId, splitAround, splitSpawn, type SplitZone } from "@/lib/splitSpawn";
import { restartPane } from "@/lib/restartPane";
import { Loader2 } from "lucide-react";
import { KillDialog, type KillMode } from "@/components/KillDialog";
import { SeparateDialog } from "@/components/SeparateDialog";
import { SpeakDialog } from "@/components/SpeakDialog";
import { ZoomBadge } from "@/components/ZoomBadge";
import { VoiceSettingsDialog } from "@/components/VoiceSettingsDialog";
import { useAgentAlerts, useNotifyPrefs } from "@/lib/notify";
import { aloneInHostTab } from "@/lib/hostFit";
import { paneLabel } from "@/lib/panes";
import { displayName, paneIdentity } from "@/lib/paneIdentity";
import { AGENT_COMMAND, agentFolder } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { eventMatches, shortcutOf } from "@/lib/shortcut";
import { useCatalog } from "@/lib/appearance";
import { LIGHT, NAVY_DARK, VSCODE_DARK, applyUI, deriveUI, normalizeUIMode, uiCSSPayload, type UIColors } from "@/lib/uiTheme";

// Um socket por pagina (fora do React: o StrictMode monta duas vezes).
const conn = new Connection();
// Qualquer link http(s) da propria UI (inclusive futuros paineis) abre so'
// no navegador padrao do sistema, nunca dentro da janela do app (caminho
// unico, ver lib/links.ts).
installLinkGuard(conn);
// Temas, fontes, configuracoes e organizacao salvas (web-settings.json).
void loadCatalog(conn);
const requestShells = () => conn.requestShells();

const OLD_VIEWS_KEY = "bethstudio-web.views"; // organizacao antiga (so' migracao)
const MODE_KEY = "bethstudio-web.sidebar";

/** Tira o open= da URL depois do primeiro uso: um F5 não deve repetir o pedido. */
function clearOpenParam() {
  try {
    const u = new URL(window.location.href);
    if (!u.searchParams.has("open")) return;
    u.searchParams.delete("open");
    window.history.replaceState(null, "", u.pathname + u.search + u.hash);
  } catch {
    /* sem history: o open= só se repetiria no próximo F5 */
  }
}

/** Quem pediu a próxima mudança de layout (para o registro de terminal que muda de aba). */
let moveWhy = "";
const why = (s: string) => {
  moveWhy = s;
};

/** Diagnóstico: uma linha "layout: …" no log do Studio (e no host-life.log nas versões novas). */
function logLayout(conn: Connection, text: string) {
  const msg = `layout: ${text}`;
  console.info(msg);
  void conn.api("/api/log", { msg }).catch(() => undefined);
}

/** Diagnóstico (vai para o host-life.log): terminal que saiu de uma aba para outra, e por quê. */
function logMoves(conn: Connection, prev: L.Layout, next: L.Layout) {
  const reason = moveWhy || "não identificada";
  moveWhy = "";
  for (const m of L.movedPanes(prev, next)) {
    logLayout(conn, `terminal ${m.pane} saiu da aba “${m.from}” para “${m.to}”${m.fromEmpty ? " (a aba de origem ficou vazia)" : ""}; origem: ${reason}`);
  }
}

function openParam(): number[] {
  return L.parseOpenParam(new URLSearchParams(window.location.search).get("open"));
}

function oldViews(): number[] {
  try {
    const ids = JSON.parse(localStorage.getItem(OLD_VIEWS_KEY) ?? "[]");
    return Array.isArray(ids) ? ids.filter((n) => Number.isInteger(n) && n >= 0) : [];
  } catch {
    return [];
  }
}

/**
 * Organizacao do web: estado local + gravacao no Go (/api/layout).
 * Mudancas locais valem na hora; o que vem do servidor so' substitui o
 * local quando nao ha' gravacao pendente (evita "voltar" uma mudanca).
 */
function useWebLayout(settings: SettingsEvent | null, panes: PaneInfo[] | null, onError: (m: string) => void, onNotice: (m: string) => void) {
  const [layout, setLayout] = useState<L.Layout | null>(null);
  const localJSON = useRef("");
  const pending = useRef(0);
  const localOnly = useRef(false); // mudanca local ainda nao enviada (arrastando divisoria)
  const timer = useRef<number | undefined>(undefined);
  const openedParam = useRef(false);
  const repairedDups = useRef("");

  const lastSaved = useRef(""); // resumo do último layout gravado (registro de diagnóstico)
  const loadLogged = useRef(false);
  const save = useCallback(
    (l: L.Layout) => {
      const sum = L.layoutSummary(L.stripPlaceholders(l));
      if (sum !== lastSaved.current) {
        lastSaved.current = sum;
        logLayout(conn, `gravado: ${sum}`);
      }
      localOnly.current = false;
      pending.current++;
      conn
        .api<SettingsEvent>("/api/layout", { layout: L.stripPlaceholders(l) })
        .then((s) => {
          pending.current--;
          if (pending.current === 0) conn.setSettings(s);
        })
        .catch((e: Error) => {
          pending.current--;
          onError(`Não foi possível salvar a organização: ${e.message}`);
        });
    },
    [onError, conn],
  );

  /** delay: 0 = grava ja'; >0 = agrupa (arrastar divisoria); -1 = so' local */
  const current = useRef<L.Layout | null>(null);
  current.current = layout;
  const commit = useCallback(
    (l: L.Layout, delay = 0) => {
      if (current.current) logMoves(conn, current.current, l);
      moveWhy = "";
      // compara com o que o servidor devolve (sem os marcadores "abrindo…")
      localJSON.current = JSON.stringify(L.stripPlaceholders(l));
      current.current = l;
      setLayout(l);
      window.clearTimeout(timer.current);
      if (delay < 0) {
        localOnly.current = true;
        return;
      }
      if (delay === 0) save(l);
      else timer.current = window.setTimeout(() => save(l), delay);
    },
    [save, conn],
  );

  useEffect(() => {
    if (!settings || !panes) return;
    const dups: L.DuplicatePane[] = [];
    const server = settings.layout ? L.sanitize(settings.layout, dups) : null;
    if (!server) {
      if (layout) return;
      // Primeira vez (ou arquivo da versao anterior): monta a aba
      // "Principal" com o que estava aberto antes.
      let l = L.emptyLayout();
      const alive = new Set(panes.map((p) => p.pane_id));
      const ids = openParam().length ? openParam() : oldViews();
      for (const id of ids) if (alive.has(id)) l = L.movePaneToTab(l, id, l.active);
      openedParam.current = true;
      clearOpenParam();
      commit(l);
      return;
    }
    if (!loadLogged.current) {
      loadLogged.current = true;
      // o endereço (sem o token) mostra se a página abriu com open=; o resumo, o que o servidor tinha guardado
      const where = `${window.location.pathname}${window.location.search.replace(/([?&])t=[^&]*/, "$1t=…")}`;
      logLayout(conn, `carregado do servidor: ${L.layoutSummary(server)}; endereço: ${where}; open=[${openParam().join(",")}]`);
    }
    let next = server;
    const dupKey = dups.map((d) => `${d.pane}:${d.kept}`).join(",");
    if (dups.length && pending.current === 0 && repairedDups.current !== dupKey) {
      repairedDups.current = dupKey; // uma vez por defeito, mesmo que a gravação falhe
      // O arquivo trazia terminal em duas abas. Conserta e grava; sem isso o
      // terminal sumia de uma das abas sem aviso.
      const nameOf = (id: string) => {
        const i = server.tabs.findIndex((t) => t.id === id);
        return i < 0 ? "" : server.tabs[i].name.trim() || `Aba ${i + 1}`;
      };
      const d = dups[0];
      const titleOf = panes.find((p) => p.pane_id === d.pane);
      const what = titleOf ? `“${paneLabel(titleOf)}”` : `#${d.pane}`;
      onNotice(
        dups.length === 1
          ? `O terminal ${what} estava em duas abas; ficou só em “${nameOf(d.kept)}”`
          : `${dups.length} terminais estavam em mais de uma aba; cada um ficou numa só`,
      );
      commit(server);
      return;
    }
    if (!openedParam.current) {
      openedParam.current = true;
      const alive = new Set(panes.map((p) => p.pane_id));
      next = L.applyOpenParam(next, openParam(), alive);
      clearOpenParam();
      if (next !== server) {
        why("open= da URL");
        current.current ??= server; // carga da página: ainda não há layout em memória para comparar
        commit(next);
        return;
      }
    }
    const js = JSON.stringify(server);
    if (pending.current === 0 && !localOnly.current && js !== localJSON.current) {
      localJSON.current = js;
      if (current.current) {
        why("layout vindo do servidor (outra cópia da interface, ou outra janela)");
        logMoves(conn, current.current, server);
      }
      setLayout(server);
    }
  }, [settings, panes, layout, commit, onNotice, conn]);

  const getLayout = useCallback(() => current.current, []);
  return { layout, commit, getLayout };
}

export function App() {
  const snap = useSyncExternalStore(conn.subscribe, conn.getSnapshot);
  const drag = useDrag();
  const [error, setError] = useState<string | null>(null);
  const onError = useCallback((m: string) => setError(m), []);
  // o aviso curto (notice) é declarado mais abaixo; a ref liga os dois
  const noticeRef = useRef<(m: string) => void>(() => undefined);
  const onNotice = useCallback((m: string) => noticeRef.current(m), []);
  const { layout, commit: rawCommit, getLayout } = useWebLayout(snap.settings, snap.panes, onError, onNotice);
  // Toda mudanca de organizacao: terminal que foi para uma aba sai dos
  // grupos fechados (e grupo vazio some).
  const commit = useCallback((l: L.Layout, delay?: number) => rawCommit(L.pruneClosed(l), delay), [rawCommit]);
  const [focus, setFocus] = useState<Record<string, number>>({}); // aba -> pane em foco
  const [menu, setMenu] = useState<{
    pane: number;
    x: number;
    y: number;
    view?: "tabs";
  } | null>(null);
  const [splitMenu, setSplitMenu] = useState<{
    pane: number;
    x: number;
    y: number;
    zone?: SplitZone;
  } | null>(null);
  const [palette, setPalette] = useState(false);
  const [termGrid, setTermGrid] = useState(false);
  const [taskManager, setTaskManager] = useState(false);
  const openDatabase = () => {
    if (isRemote()) {
      openRemoteTab("mode=db");
      return;
    }
    void conn.api<{ ok: boolean }>("/api/db/window", {}).catch((e: unknown) => {
      setNotice(e instanceof Error ? e.message : "não foi possível abrir o banco de dados");
    });
  };
  const [filePreviewPath, setFilePreviewPath] = useState<string | null>(null);
  // arquivo recém-criado: o painel já abre em "Editar"
  const [editPath, setEditPath] = useState<string | null>(null);
  const [browser, setBrowser] = useState<{ mode: FolderBrowserMode; initial: string; content?: string } | null>(null);
  // "Novo arquivo": editor em branco ("Sem título"); a pasta é a sugestão ao salvar
  const [untitledDir, setUntitledDir] = useState("");
  // troca o painel inteiro quando o "Sem título" vira arquivo salvo
  const [panelKey, setPanelKey] = useState(0);
  const newScratch = (dir: string) => {
    setUntitledDir(dir);
    setEditPath(null);
    setFilePreviewPath(UNTITLED_PATH);
  };
  const winState = useWindowState();
  const [toolScreen, setToolScreen] = useState<ToolKind | null>(null);
  /** SSH/serial aberto a partir de "Novo terminal à direita/…": o pane nasce nesse split. */
  const [splitTool, setSplitTool] = useState<{ pane: number; zone: SplitZone } | null>(null);
  const [killTarget, setKillTarget] = useState<{ pane: number; mode: KillMode } | null>(null);
  const [separateTarget, setSeparateTarget] = useState<number | null>(null);
  const [speakPane, setSpeakPane] = useState<number | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [general, setGeneral] = useState(false);
  const [generalSection, setGeneralSection] = useState<SettingsSection>("aparencia");
  const openSettings = (sec: SettingsSection) => {
    setGeneralSection(sec);
    setGeneral(true);
  };
  const [newTab, setNewTab] = useState(false);
  const [pendingSpawn, setPendingSpawn] = useState<{
    pane: number;
    name: string;
    at: number;
  } | null>(null);
  const [notifyPrefs, setNotifyPrefs] = useNotifyPrefs();
  useAgentAlerts(snap.agents, snap.panes, notifyPrefs);
  const [uiPreview, setUIPreview] = useState<UIColors | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  noticeRef.current = setNotice;
  const catalog = useCatalog();
  // "Tema padrao dos terminais" escolhido pelo usuario ("" = nenhum). Nao
  // usa effectiveFor: ele ja' cai no tema da interface, e o modo "follow"
  // da interface le' daqui.
  const defaultThemeId = snap.settings?.default?.theme ?? "";
  const uiColors = useMemo<UIColors>(() => {
    const m = snap.settings?.ui_theme;
    const mode = normalizeUIMode(m?.mode);
    if (mode === "dark") return VSCODE_DARK;
    if (mode === "navy") return NAVY_DARK;
    if (mode === "light") return LIGHT;
    if (mode === "follow" && !defaultThemeId) return VSCODE_DARK;
    const t = catalog.themeById.get(mode === "follow" ? defaultThemeId : (m?.theme_id ?? ""));
    return t ? deriveUI(t) : VSCODE_DARK;
  }, [snap.settings, catalog, defaultThemeId]);
  useEffect(() => applyUI(uiPreview ?? uiColors), [uiPreview, uiColors]);
  // Guarda no Go as cores aplicadas, para o proximo abrir ja' sair certo.
  const lastCSS = useRef("");
  useEffect(() => {
    if (!snap.settings) return; // ainda nao sabemos o tema salvo
    const payload = uiCSSPayload(uiColors);
    const js = JSON.stringify(payload);
    if (js === lastCSS.current) return;
    lastCSS.current = js;
    const t = window.setTimeout(() => void conn.api("/api/settings/ui-css", payload).catch(() => undefined), 800);
    return () => window.clearTimeout(t);
  }, [uiColors, snap.settings]);
  // Soltar um arquivo fora de um terminal nao pode navegar o WebView para ele.
  useEffect(() => {
    const block = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(t);
  }, [notice]);
  const [flash, setFlash] = useState<{ pane: number; n: number } | null>(null);
  const searchState = useSearch(conn, snap.panes, layout, true);
  const [modeLocal, setModeState] = useState<SidebarMode>(() => {
    try {
      return localStorage.getItem(MODE_KEY) === "host" ? "host" : "web";
    } catch {
      return "web";
    }
  });
  const setMode = (m: SidebarMode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* ignora */
    }
  };

  const readOnly = snap.status?.read_only ?? false;
  const paneById = useMemo(() => {
    const m = new Map<number, PaneInfo>();
    snap.panes?.forEach((p) => m.set(p.pane_id, p));
    return m;
  }, [snap.panes]);

  const activeTab = layout ? L.tabById(layout, layout.active) : undefined;
  const activeLeaves = useMemo(() => L.leaves(activeTab?.root ?? null), [activeTab]);
  const focusedPane = (() => {
    if (!activeTab) return null;
    const f = focus[activeTab.id];
    const live = activeLeaves.filter((l) => !l.leaf.gone && !L.isPlaceholder(l.leaf.pane));
    return live.some((l) => l.leaf.pane === f) ? f : (live[0]?.leaf.pane ?? null);
  })();

  // Observa so' os terminais visiveis (aba ativa).
  useEffect(() => {
    conn.setWatched(activeLeaves.filter((l) => !l.leaf.gone && paneById.has(l.leaf.pane)).map((l) => l.leaf.pane));
  }, [activeLeaves, paneById]);

  // Escondido na bandeja ou minimizado por mais de 3 s: para de observar (a
  // ponte deixa de consultar as telas a cada 30 ms). Voltou: observa de novo.
  useEffect(() => {
    let t: number | undefined;
    const apply = () => {
      window.clearTimeout(t);
      if (document.visibilityState === "hidden") t = window.setTimeout(() => conn.setWatchPaused(true), 3000);
      else conn.setWatchPaused(false);
    };
    document.addEventListener("visibilitychange", apply);
    apply();
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("visibilitychange", apply);
    };
  }, []);

  // --- acoes -----------------------------------------------------------
  // "Abrir arquivo…": janela do Windows, começando na pasta do terminal em foco
  // pasta do terminal em foco, como caminho do Windows (\\wsl.localhost\... no WSL)
  const focusedFolder = () => {
    const p = focusedPane !== null ? paneById.get(focusedPane) : undefined;
    return p?.cwd
      ? paneFolder(p.cwd, { paneKind: p.kind, paneWsl: p.wsl, paneDistro: p.wsl_distro || p.distro, paneCwd: p.cwd }, !/Windows/.test(navigator.userAgent))
      : "";
  };
  const openFileDialog = () => {
    const initial = focusedFolder();
    // Studio remoto: o "Abrir" do Windows apareceria no PC; usa o navegador da página.
    if (isRemote()) {
      setBrowser({ mode: "file", initial });
      return;
    }
    void conn
      .api<{ path?: string; canceled?: boolean }>("/api/local-file/open-dialog", { initial })
      .then((r) => r.path && setFilePreviewPath(r.path))
      .catch((e: unknown) => setNotice(e instanceof Error ? e.message : "não foi possível abrir o arquivo"));
  };
  const focusPane = (tabId: string, pane: number) => setFocus((f) => withTabFocus(f, tabId, pane));

  // "Novo terminal à direita/abaixo/…": aba nova NA MESMA JANELA do host
  // (nunca split no host); no web entra ao lado do terminal clicado.
  // untilListed: o split só é gravado depois que o pane está na lista.
  // Gravar antes faz o servidor marcar a folha como "terminal encerrado".
  const untilListed = (paneId: number) =>
    new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (conn.getSnapshot().panes?.some((p) => p.pane_id === paneId)) {
          resolve();
          return;
        }
        if (Date.now() - start > 8000) {
          reject(new Error("o terminal foi criado, mas ainda não apareceu na lista do Beth Studio"));
          return;
        }
        window.setTimeout(tick, 40);
      };
      tick();
    });
  const agentFolderRequests = useRef(new Set<number>());
  const openAgentFolder = (paneId: number, dest: string): boolean => {
    const info = paneById.get(paneId);
    if (!info) return false;
    const tool = paneIdentity({ title: info.title, tool: info.tool, screen: conn.lastScreenText(paneId) }, "").tool;
    if (!tool) return false;
    if (agentFolderRequests.current.has(paneId)) return true;
    agentFolderRequests.current.add(paneId);
    void (async () => {
      if (info.kind === "ssh" || info.kind === "serial") throw new Error("esta ação requer um terminal local");
      const shells = await conn.ensureShells();
      const localShell = shells.find((s) => ["login", "zsh", "bash", "sh"].includes(s.id))?.id;
      const wsl = info.wsl || info.kind === "wsl";
      const sameShell = sameShellId(wsl ? { kind: "wsl", distro: info.wsl_distro ?? info.distro } : info, shells);
      const shell = sameShell ?? (wsl ? null : localShell ?? shells.find((s) => ["pwsh", "powershell", "cmd"].includes(s.id))?.id);
      if (!shell) throw new Error("nenhum shell compatível disponível");
      const cwd = agentFolder(dest, info.cwd, shell);
      if (!cwd) throw new Error("o caminho informado não é válido para este shell");
      return conn.spawn({ shell_id: shell, window_id: info.window_id, cwd });
    })().then(async ({ pane_id }) => {
        await untilListed(pane_id);
        const latest = getLayout();
        if (!latest) throw new Error("a organização das abas não está disponível");
        const next = L.addTab(latest, displayName(tool), pane_id);
        commit(next);
        focusPane(next.active, pane_id);
        if (!conn.send(pane_id, AGENT_COMMAND[tool] + "\r")) throw new Error("sem conexão com o terminal novo");
      })
      .catch((e: Error) => setError(`Não foi possível abrir ${displayName(tool)} na nova pasta: ${e.message}`))
      .finally(() => agentFolderRequests.current.delete(paneId));
    return true;
  };
  const newSplit = (target: number, zone: SplitZone, shellId: string, label: string) => {
    const info = paneById.get(target);
    if (!info) return;
    void splitSpawn({ spawn: (o) => conn.spawn(o), getLayout, commit, onError, untilListed }, info, zone, shellId, label).then((pane) => {
      const l = getLayout();
      const at = pane !== null && l ? L.findPane(l, pane) : null;
      if (at && pane !== null) focusPane(at.tabId, pane);
    });
  };

  // Nome de aba dado pelo usuario, guardado por pane (web-settings.json).
  const paneNamesRef = useRef<Record<string, string>>({});
  paneNamesRef.current = snap.settings?.pane_names ?? {};
  const storedName = (pane: number) => paneNamesRef.current[String(pane)] ?? "";
  /** Renomear aba: o nome vale tambem para cada terminal dela (reabrir => mesmo nome). */
  const renameTabAndPanes = (id: string, name: string) => {
    if (!layout) return;
    const panes = L.tabPanes(L.tabById(layout, id));
    commit(L.renameTab(layout, id, name));
    if (panes.length)
      void conn
        .api<SettingsEvent>("/api/settings/pane-names", { pane_ids: panes, name: name.trim() })
        .then((s) => conn.setSettings(s))
        .catch((e: Error) => onError(`Não foi possível guardar o nome: ${e.message}`));
  };
  // Abas fechadas ficam guardadas no layout (web-settings.json): clicar num
  // terminal delas, "Reabrir aba" na barra lateral ou "Reabrir aba fechada".
  const alivePanes = () => new Set((snap.panes ?? []).map((x) => x.pane_id));
  const closeTabKeep = (id: string) => {
    if (!layout) return;
    commit(L.closeTab(layout, id));
  };
  // Menu da aba: "Matar terminal…" e "Reiniciar este terminal…" agem no terminal em foco da aba.
  const tabFocusedPane = (tabId: string): number | null => {
    const t = layout ? L.tabById(layout, tabId) : undefined;
    const live = L.leaves(t?.root ?? null).filter((l) => !l.leaf.gone && !L.isPlaceholder(l.leaf.pane) && paneById.has(l.leaf.pane));
    const f = focus[tabId];
    return live.some((l) => l.leaf.pane === f) ? f : (live[0]?.leaf.pane ?? null);
  };
  const tabTerminal = readOnly
    ? undefined
    : (tabId: string) => {
        const pane = tabFocusedPane(tabId);
        if (pane === null) return null;
        const shell = sameShellId(paneById.get(pane), snap.shells);
        return {
          onKill: () => setKillTarget({ pane, mode: "matar" }),
          onRestart: shell ? () => setKillTarget({ pane, mode: "reiniciar" }) : undefined,
          restartBlocked: shell ? undefined : "Só dá para reiniciar PowerShell, pwsh, cmd, WSL, Git Bash e MobaXterm",
        };
      };
  const matarDone = (pane: number) => {
    const l = getLayout();
    if (l) commit(L.detachPaneClosingEmpty(l, pane));
  };
  const restartTerminal = (pane: number, end: (pane: number) => boolean) => {
    const info = paneById.get(pane);
    const shell = sameShellId(info, snap.shells);
    if (!info || !shell) return;
    const name = storedName(pane);
    void restartPane({ spawn: (o) => conn.spawn(o), untilListed, getLayout, commit, end: (p) => void end(p) }, info, shell)
      .then((np) => {
        const l = getLayout();
        const at = l ? L.findPane(l, np) : null;
        if (at) focusPane(at.tabId, np);
        if (name)
          void conn
            .api<SettingsEvent>("/api/settings/pane-names", { pane_ids: [np], name })
            .then((s) => conn.setSettings(s))
            .catch(() => undefined);
      })
      .catch((e: Error) => onError(`Não foi possível reiniciar o terminal (ele continua como estava): ${e.message}`));
  };
  const reopenClosedAt = (index: number) => {
    if (!layout) return;
    const r = L.restoreClosed(layout, index, alivePanes());
    commit(r.layout);
    if (!r.tabId) setNotice("Os terminais daquela aba já estão em outras abas ou foram encerrados");
  };
  const reopenClosed = () => reopenClosedAt(0);

  const act = useMemo(() => {
    if (!layout) return null;
    const ensureIn = (l: L.Layout, pane: number) => (L.findPane(l, pane) ? l : L.movePaneToTab(l, pane, l.active));
    const open = (what: string, l: L.Layout) => {
      why(what);
      commit(l);
    };
    const a = {
      open(pane: number) {
        // Em janela destacada: so' traz a janela para a frente.
        if (conn.getSnapshot().termWindows.includes(pane)) {
          void conn.api("/api/term/focus", { pane_id: pane }).catch(() => undefined);
          return;
        }
        // Ja' organizado: vai ate' a aba dele. Senao: aba NOVA so' com ele
        // (nunca substitui o terminal em foco).
        const r = L.openPaneInTab(layout, pane, storedName(pane), alivePanes());
        commit(r.layout);
        focusPane(r.tabId, pane);
      },
      openBeside(pane: number) {
        const next = focusedPane !== null ? L.dropOnPane(layout, pane, focusedPane, "right") : L.movePaneToTab(layout, pane, layout.active);
        open("Abrir ao lado", next);
        focusPane(layout.active, pane);
      },
      moveToTab(pane: number, tabId: string) {
        open("menu: mover para a aba", L.movePaneToTab(layout, pane, tabId));
      },
      moveToNewTab(pane: number) {
        open("menu: mover para nova aba", L.addTab(layout, storedName(pane), pane));
      },
      splitWith(target: number, other: number, zone: Exclude<L.Zone, "center">) {
        const l = ensureIn(layout, target);
        open("dividir com outro terminal", L.dropOnPane(l, other, target, zone));
      },
      unorganize(pane: number) {
        commit(L.detachPane(layout, pane));
      },
      /** Janela nativa: sai das abas e o Go abre o processo da janela. */
      detach(pane: number) {
        commit(L.detachPaneClosingEmpty(layout, pane));
        conn.api("/api/term/detach", { pane_id: pane }).catch((e: unknown) => {
          commit(layout); // nao abriu: volta para onde estava
          setNotice(e instanceof Error ? e.message : "não foi possível abrir a janela");
        });
      },
      dropOnPane(pane: number, target: number, zone: L.Zone) {
        open("arrastar para dentro de um terminal", L.dropOnPane(layout, pane, target, zone));
        const at = L.findPane(layout, target);
        if (at) focusPane(at.tabId, pane);
      },
      dropOnTab(pane: number, tabId: string | null) {
        if (tabId === null) open("arrastar para o +", L.addTab(layout, "", pane));
        else open("arrastar para a aba", L.movePaneToTab(layout, pane, tabId));
      },
    };
    return a;
  }, [layout, commit, focusedPane]);

  // Terminal destacado: o Go manda onde esta' o cursor enquanto a janela nativa
  // e' arrastada; aqui o arrasto vira eventos de drag da pagina, e as zonas de
  // soltar (paineis, abas, "+") funcionam como no arrasto da lista.
  // A bandeja do Studio pede o gerenciador de tarefas ("Sistema").
  useEffect(() => conn.onUiOpen((what) => what === "tasks" && setTaskManager(true)), []);
  const termDragLast = useRef<Element | null>(null);
  useEffect(
    () =>
      conn.onTermDrag((e) => {
        const closeWindow = () => void conn.api("/api/term/close", { pane_id: e.pane }).catch(() => undefined);
        const l = getLayout();
        if (e.attach) {
          // botao "Encaixar" da janela: vai para a aba ativa
          if (!l) return;
          why("Encaixar janela destacada");
          commit(L.movePaneToTab(l, e.pane, l.active));
          focusPane(l.active, e.pane);
          closeWindow();
          return;
        }
        const pt = toCssPoint(e.x, e.y, window.devicePixelRatio || 1);
        // So' a barra de abas recebe a janela destacada (paineis nao).
        const hit = pointInPage(pt, window.innerWidth, window.innerHeight) ? document.elementFromPoint(pt.x, pt.y) : null;
        const el = hit?.closest('[data-term-drop="tabs"]') ? hit : null;
        const prev = termDragLast.current;
        if (prev && prev !== el) dispatchPaneDrag(prev, "dragleave", e.pane, pt);
        termDragLast.current = el;
        if (!e.end) {
          if (el) {
            beginExternalPaneDrag(e.pane);
            dispatchPaneDrag(el, "dragover", e.pane, pt);
          } else endDrag();
          return;
        }
        if (el) dispatchPaneDrag(el, "drop", e.pane, pt);
        termDragLast.current = null;
        // so' fecha a janela se o pane entrou mesmo no layout (soltou numa zona valida)
        const overBar = !!el;
        window.setTimeout(() => {
          let now = getLayout();
          // soltou num espaco vazio da barra (sem aba sob o cursor): vira aba nova
          if (overBar && now && !L.findPane(now, e.pane)) {
            commit(L.addTab(now, "", e.pane));
            now = getLayout();
          }
          if (shouldCloseAfterDrop(!!now && !!L.findPane(now, e.pane))) closeWindow();
          endDrag();
        }, 80);
      }),
    [getLayout, commit],
  );

  const tabTitleOf = (t: L.WebTab) =>
    layout ? L.tabDisplayName(t, layout.tabs.indexOf(t), (p) => {
        const info = paneById.get(p);
        return info ? paneLabel(info) : undefined;
      }, focus[t.id] ?? null) : t.name;
  const where = (pane: number) => {
    if (!layout) return "";
    const at = L.findPane(layout, pane);
    const t = at ? layout.tabs.find((tt) => tt.id === at.tabId) : undefined;
    return t ? `Aba “${tabTitleOf(t)}”` : "Não organizados";
  };
  const resultActions: ResultActions | null =
    act && layout
      ? {
          go: (r) => {
            if (r.entry.gone) {
              const t = layout.tabs.find((tt) => L.leaves(tt.root).some((l) => l.leaf.gone && l.leaf.pane === r.entry.pane));
              if (t) commit(L.setActive(layout, t.id));
              return;
            }
            act.open(r.entry.pane);
            setFlash((f) => ({ pane: r.entry.pane, n: (f?.n ?? 0) + 1 }));
          },
          openBeside: (pane) => {
            act.openBeside(pane);
            setFlash((f) => ({ pane, n: (f?.n ?? 0) + 1 }));
          },
          moveMenu: (pane, x, y) => setMenu({ pane, x, y, view: "tabs" }),
        }
      : null;

  const menuActions: PaneMenuActions | null = act
    ? {
        moveToTab: act.moveToTab,
        moveToNewTab: act.moveToNewTab,
        splitWith: act.splitWith,
        unorganize: act.unorganize,
        detach: readOnly || isRemote() ? undefined : act.detach,
        askKill: readOnly ? undefined : (pane: number) => setKillTarget({ pane, mode: "encerrar" }),
        askSeparate: readOnly ? undefined : (pane: number) => setSeparateTarget(pane),
        inHostSplit: (pane: number) => !aloneInHostTab(snap.panes, pane) && paneById.has(pane),
        newSplit: readOnly ? undefined : (pane: number, zone: SplitZone, x: number, y: number) => setSplitMenu({ pane, x, y, zone }),
      }
    : null;

  // LED da conexao: na faixa do titulo da barra lateral (na barra de abas so' com a lateral recolhida).
  const connLed = (
    <ConnLed
      socket={snap.socket}
      status={snap.status}
      readOnly={readOnly}
      onClick={() => (snap.socket === "open" ? conn.refreshList() : conn.reconnectNow())}
    />
  );
  // Botoes de ferramenta: na barra lateral (na barra de abas so' com a lateral recolhida).
  // Restauracao dos terminais depois de uma queda do host: faixa com o progresso e, no fim, o resumo.
  const [restoreDismissed, setRestoreDismissed] = useState(false);
  const [, restoreTick] = useState(0);
  useEffect(() => {
    setRestoreDismissed(false);
    if (snap.restoreFinishedAt === 0) return;
    const t = window.setTimeout(() => restoreTick((n) => n + 1), 8200); // o resumo "tudo certo" some sozinho
    return () => window.clearTimeout(t);
  }, [snap.restore]);
  const restoreInfo = restoreBanner(snap.restore, Date.now(), snap.restoreFinishedAt);
  const studioActions = buildStudioActions({
    onSearch: () => setPalette(true),
    onGeneral: () => openSettings("aparencia"),
    onTaskManager: () => setTaskManager(true),
    onDatabase: openDatabase,
    onTools: () => setToolScreen("ssh"),
    onOpenFile: openFileDialog,
    onNewFile: () => newScratch(focusedFolder()),
    onSpeak: readOnly || focusedPane === null ? undefined : () => setSpeakPane(focusedPane),
  });

  const bridgeDown = snap.socket === "open" && snap.status && snap.status.state !== "up";
  const shortcuts = snap.settings?.shortcuts;
  const searchShortcut = shortcutOf(shortcuts, "search");

  // Abas do web com algum agente aguardando.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement | null)?.isContentEditable;
      const hit = (id: string) => eventMatches(e, shortcutOf(shortcuts, id));
      if (hit("search") && (!typing || (e.target as HTMLElement).id === "beth-search")) {
        e.preventDefault();
        document.getElementById("beth-search")?.focus();
        return;
      }
      if (typing) return;
    if (hit("settings")) {
      e.preventDefault();
      openSettings("atalhos");
      return;
    }
    if (!layout) return;
    if (hit("new_tab")) {
      e.preventDefault();
      commit(L.addTab(layout, ""));
      return;
    }
    if (hit("close_tab")) {
      e.preventDefault();
      commit(L.closeTab(layout, layout.active));
      return;
    }
    if (hit("next_tab") || hit("prev_tab")) {
      e.preventDefault();
      const ids = layout.tabs.map((t) => t.id);
      const i = ids.indexOf(layout.active);
      if (i < 0 || ids.length < 2) return;
      const step = hit("next_tab") ? 1 : -1;
      const next = ids[(i + step + ids.length) % ids.length];
      commit(L.setActive(layout, next));
    }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchShortcut, shortcuts, layout]);

  const waitingTabs = useMemo(() => {
    const s = new Set<string>();
    if (layout) for (const t of layout.tabs) if (L.leaves(t.root).some((l) => !l.leaf.gone && snap.agents[l.leaf.pane])) s.add(t.id);
    return s;
  }, [layout, snap.agents]);
  // Barra lateral: recolhida/largura em web-settings.json.
  type SidebarPrefs = {
    collapsed: boolean;
    width: number;
    view?: string;
    kinds?: string[];
    kind_order?: string[];
    split_by_kind?: boolean;
    files_width?: number;
  };
  const [sidebarLocal, setSidebarLocal] = useState<SidebarPrefs | null>(null);
  // Pasta da guia: gravada no layout (web-settings.json), não no localStorage.
  // O WebView do macOS não guarda o localStorage entre aberturas.
  // Aberto nesta sessão. O layout gravado também vale, mas o botão não
  // pode depender só dele: um servidor antigo descarta files_open.
  const [filesNow, setFilesNow] = useState<Record<string, boolean>>({});
  const filesOpen = activeTab ? (filesNow[activeTab.id] ?? activeTab.files_open === true) : false;
  const setFilesOpen = (open: boolean) => {
    if (!activeTab) return;
    setFilesNow((cur) => ({ ...cur, [activeTab.id]: open }));
    if (layout) commit(L.setTabFilesOpen(layout, activeTab.id, open));
  };
  const sidebarPrefs: SidebarPrefs = sidebarLocal ?? snap.settings?.sidebar ?? { collapsed: false, width: 288 };
  // Depois que /api/settings chegou, campo ausente é desligado. O
  // localStorage só cobre o instante anterior à resposta; senão um "1"
  // antigo religa o material quando o JSON omite false.
  const vibrancy = isMacTitlebar() && shellVibrancyOn(
    snap.settings?.ui_theme,
    snap.settings != null,
    typeof localStorage !== "undefined" && localStorage.getItem("bethstudio-vibrancy") === "1",
  );
  const [paneTools, setPaneTools] = useState<Record<number, string>>({});
  useEffect(() => {
    if (!layout) return;
    const ids = layout.tabs.flatMap((t) => L.leaves(t.root).map((l) => l.leaf.pane));
    const missing = ids.filter((id) => !paneTools[id] && !conn.lastScreenText(id));
    if (missing.length === 0) return;
    const stops = missing.map((id) =>
      conn.peekScreen(id, (text) => setPaneTools((m) => (m[id] === text ? m : { ...m, [id]: text }))),
    );
    return () => stops.forEach((s) => s());
  }, [layout, conn, paneTools]);
  const sidebarCollapsed = sidebarPrefs.collapsed;
  const [dragWidth, setSidebarWidth] = useState<number | null>(null);
  const [dragFiles, setFilesWidth] = useState<number | null>(null);
  const sidebarWidth = dragWidth ?? sidebarPrefs.width ?? 288;
  const filesWidth = dragFiles ?? sidebarPrefs.files_width ?? 308;
  useEffect(() => {
    if (!isMacTitlebar()) return;
    const w = window as unknown as {
      webkit?: { messageHandlers?: { bethVibrancy?: { postMessage: (v: string) => void }; bethSidebar?: { postMessage: (v: string) => void } } };
    };
    document.documentElement.classList.toggle("bt-vibrancy", vibrancy);
    document.documentElement.style.setProperty("--bt-side", `${sidebarCollapsed ? 48 : sidebarWidth}px`);
    const dark = document.documentElement.classList.contains("dark");
    const topbarRgb = dark ? "19 19 19" : "236 236 236";
    document.documentElement.style.setProperty("--bt-topbar-rgb", topbarRgb);
    document.documentElement.style.setProperty("--bt-topbar", `rgb(${topbarRgb})`);
    // O vão tem de ser opaco. Transparente deixa o material nativo aparecer.
    document.body.style.background = vibrancy ? "transparent" : "";
    w.webkit?.messageHandlers?.bethVibrancy?.postMessage(vibrancy ? "1" : "0");
    const power = (snap.settings?.ui_theme?.glass || 55) / 100;
    const alpha = (snap.settings?.ui_theme?.glass_alpha || 70) / 100;
    document.documentElement.style.setProperty("--bt-preview-vibrancy-opacity", String(0.34 + alpha * 0.32));
    (w.webkit?.messageHandlers as { bethGlassTune?: { postMessage: (v: string) => void } } | undefined)?.bethGlassTune?.postMessage(`${power},${alpha}`);
    const width = !vibrancy ? 0 : sidebarCollapsed ? 48 : sidebarWidth;
    w.webkit?.messageHandlers?.bethSidebar?.postMessage(String(width));
    const probe = document.createElement("span");
    probe.style.background = getComputedStyle(document.documentElement).getPropertyValue("--bt-topbar").trim() || "rgb(26, 26, 26)";
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    document.body.appendChild(probe);
    const gutter = getComputedStyle(probe).backgroundColor || "rgb(18, 18, 18)";
    probe.remove();
    (w.webkit?.messageHandlers as { bethGutter?: { postMessage: (v: string) => void } } | undefined)?.bethGutter?.postMessage(gutter);
  }, [vibrancy, sidebarCollapsed, sidebarWidth, snap.settings?.ui_theme?.glass, snap.settings?.ui_theme?.glass_alpha]);
  const previewOpen = !!filePreviewPath;
  useEffect(() => {
    if (!isMacTitlebar() || !vibrancy || previewOpen) {
      const off = window as unknown as { webkit?: { messageHandlers?: { bethGlass?: { postMessage: (v: string) => void } } } };
      off.webkit?.messageHandlers?.bethGlass?.postMessage("[]");
      return;
    }
    const pngCache = new Map<string, string>();
    const iconPng = (el: Element): Promise<string> => {
      const svg = el.querySelector("svg");
      if (!svg) return Promise.resolve("");
      const key = svg.outerHTML;
      const hit = pngCache.get(key);
      if (hit) return Promise.resolve(hit);
      const clone = svg.cloneNode(true) as SVGElement;
      if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("width", "32");
      clone.setAttribute("height", "32");
      clone.setAttribute("color", "#ffffff");
      clone.querySelectorAll("*").forEach((n) => {
        const stroke = n.getAttribute("stroke");
        const fill = n.getAttribute("fill");
        if (stroke === "currentColor" || stroke == null) n.setAttribute("stroke", "#ffffff");
        if (fill === "currentColor") n.setAttribute("fill", "#ffffff");
      });
      const xml = new XMLSerializer().serializeToString(clone);
      const src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = 64;
          c.height = 64;
          const ctx = c.getContext("2d");
          if (!ctx) return resolve("");
          ctx.drawImage(img, 0, 0, 64, 64);
          const data = c.toDataURL("image/png").split(",")[1] || "";
          if (data) pngCache.set(key, data);
          resolve(data);
        };
        img.onerror = () => resolve("");
        img.src = src;
      });
    };
    const w = window as unknown as { webkit?: { messageHandlers?: { bethGlass?: { postMessage: (v: string) => void } } } };
    let last = "";
    let disposed = false;
    let request = 0;
    let delivered = 0;
    const send = () => {
      const modal = !!document.querySelector(".bt-modal");
      const sequence = ++request;
      const found = modal
        ? [...document.querySelectorAll(".bt-glass-sample")]
        : [...document.querySelectorAll(".bt-tab:not(.bt-tab-active), .bt-tab-tool, .bt-sidebar .bt-glass, .bt-sidebar .bt-search, .bt-sidebar .bt-chat, .bt-sidebar .bt-chip")];
      const nodes = nativeGlassPlates(true, found);
      void Promise.all(nodes.map(iconPng)).then((pngs) => {
        if (disposed || sequence < delivered) return;
        delivered = sequence;
        const rects: { x: number; y: number; w: number; h: number; r: number; p: string; t: string; sub: string; hov: number; f: number; on: number; ph: number; tip: number; side: string; ax: number; wrap: number; row: number }[] = [];
        nodes.forEach((el, i) => {
          const b = el.getBoundingClientRect();
          if (b.width < 8 || b.height < 4 || b.height > 110 || b.width > 420) return;
          if (b.bottom < 0 || b.top > window.innerHeight) return;
          const rad = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 8;
          const field = el.classList.contains("bt-search");
          const tip = el.classList.contains("bt-tip");
          const chat = el.classList.contains("bt-chat");
          const input = el.querySelector("input");
          const typed = input?.value || "";
          const name = field
            ? typed || input?.placeholder || "Buscar terminal ou pasta"
            : tip
              ? (el.querySelector(".font-medium")?.textContent || "").trim()
              : chat
                ? (el.querySelector("span.truncate")?.textContent || "").replace(/\s+/g, " ").trim()
                : (el.textContent || "").replace(/\s+/g, " ").trim();
          const sub = tip
            ? (el.querySelector(".text-white\\/70")?.textContent || "").trim()
            : chat
              ? (el.querySelector(".font-mono")?.textContent || "").replace(/\s+/g, " ").trim()
              : "";
          rects.push({
            x: Math.round(b.x),
            y: Math.round(b.y),
            w: Math.round(b.width),
            h: Math.round(b.height),
            r: field ? 16 : Math.round(rad),
            p: field ? "" : pngs[i] || "",
            t: name.slice(0, 48),
            sub: sub.slice(0, 48),
            hov: el.matches(":hover") ? 1 : 0,
            f: field ? 1 : 0,
            tip: tip ? 1 : 0,
            side: tip ? el.getAttribute("data-tip-side") || "below" : "",
            ax: tip ? Number(el.getAttribute("data-tip-arrow") || 0) : 0,
            on: el.classList.contains("bt-glass-on") ? 1 : 0,
            ph: field && !typed ? 1 : 0,
            wrap: el.classList.contains("bt-mode") ? 1 : 0,
            row: chat || (el.closest(".bt-sidebar") && !el.classList.contains("bt-mode") && !el.classList.contains("h-7") && !field) ? 1 : 0,
          });
        });
        rects.sort((a, b) => a.tip - b.tip);
        const json = JSON.stringify(rects);
        if (json === last) return;
        last = json;
        w.webkit?.messageHandlers?.bethGlass?.postMessage(json);
      });
    };
    let frame = 0;
    const kick = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        send();
      });
    };
    kick();
    const timer = window.setInterval(kick, 120);
    window.addEventListener("resize", kick);
    document.addEventListener("mouseover", kick);
    document.addEventListener("mouseout", kick);
    document.addEventListener("input", kick);
    document.addEventListener("transitionrun", kick);
    const watch = new MutationObserver(kick);
    watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    return () => {
      disposed = true;
      window.clearInterval(timer);
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", kick);
      document.removeEventListener("mouseover", kick);
      document.removeEventListener("mouseout", kick);
      document.removeEventListener("input", kick);
      document.removeEventListener("transitionrun", kick);
      watch.disconnect();
    };
  }, [vibrancy, sidebarCollapsed, sidebarWidth, snap.settings?.ui_theme?.glass, snap.settings?.ui_theme?.glass_alpha, previewOpen]);
  const saveSidebar = (patch: Partial<SidebarPrefs>) => {
    const next = { ...sidebarPrefs, ...patch };
    setSidebarLocal(next);
    setSidebarWidth(null);
    conn
      .api<SettingsEvent>("/api/settings/sidebar", next)
      .then((s) => {
        conn.setSettings(s);
        setSidebarLocal(null);
      })
      .catch((e: Error) => setError(`Não foi possível salvar a barra lateral: ${e.message}`));
  };
  const waitingNow = Object.values(snap.agents).filter((a) => paneById.has(a.pane));
  const waitingCount = waitingNow.length;
  const firstWaiting = waitingNow.sort((a, b) => a.since - b.since)[0]?.pane;

  const goPane = (pane: number) => {
    act?.open(pane);
    setFlash((f) => ({ pane, n: (f?.n ?? 0) + 1 }));
  };

  // Terminal criado no host: espera o pane aparecer na lista e cria a aba.
  useEffect(() => {
    if (!pendingSpawn || !layout || !snap.panes) return;
    if (snap.panes.some((p) => p.pane_id === pendingSpawn.pane)) {
      const l = L.addTab(layout, pendingSpawn.name, pendingSpawn.pane);
      commit(l);
      focusPane(l.active, pendingSpawn.pane);
      setPendingSpawn(null);
      return;
    }
    const t = window.setTimeout(
      () => {
        setPendingSpawn(null);
        setError("O terminal foi criado, mas ainda não apareceu na lista do BethStudio. Procure em Não organizados.");
      },
      Math.max(0, 8000 - (Date.now() - pendingSpawn.at)),
    );
    return () => window.clearTimeout(t);
  }, [pendingSpawn, layout, snap.panes, commit]);

  return (
    <div className={cn("flex h-full flex-col text-text-1", vibrancy ? "" : "bg-bg-body")}>
      <TopResizeEdges state={winState} />
      <TooltipLayer />
      {/* Avisos */}
      {snap.socket === "closed" && (
        <Banner tone="err">
          Sem conexão com o bethstudio-web. Tentando reconectar…
          <button className="ml-3 rounded bg-white/10 px-2 py-0.5 hover:bg-white/20" onClick={() => conn.reconnectNow()}>
            Reconectar agora
          </button>
        </Banner>
      )}
      {bridgeDown && (
        <Banner tone="warn">{snap.status?.message || "Ponte com o Beth Studio indisponível."}</Banner>
      )}
      {snap.lastError && (
        <Banner tone="warn" onClose={() => conn.clearError()}>
          {snap.lastError}
        </Banner>
      )}
      {error && (
        <Banner tone="warn" onClose={() => setError(null)}>
          {error}
        </Banner>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="bt-side-col relative h-full shrink-0 self-stretch" style={{ width: sidebarCollapsed ? 48 : sidebarWidth, background: vibrancy ? "transparent" : "rgb(19, 19, 19)" }}>
        <div
          className="bt-mac-gutter absolute inset-x-0 top-0 z-30 h-10"
          style={{ background: "rgb(19, 19, 19)" }}
          title="Arraste para mover a janela"
          onMouseDown={(e) => {
            if (!isMacTitlebar() || e.button !== 0 || e.detail > 1) return;
            e.preventDefault();
            dragMacWindow();
          }}
          onDoubleClick={() => isMacTitlebar() && zoomMacWindow()}
        />
        <div className="bt-side-slot bt-side-slot-left absolute inset-x-0" style={{ top: 48, bottom: 8, padding: "0 8px", background: vibrancy ? "transparent" : undefined }}>
        <aside
          className={cn(
            "bt-sidebar relative h-full overflow-hidden",
            vibrancy ? "bg-transparent" : "bg-bg-panel",
            "bt-side-card",
            sidebarCollapsed && "flex flex-col items-center gap-1 overflow-y-auto overflow-x-hidden pb-2 [scrollbar-width:none]",
          )}
          style={{ width: "100%" }}
        >
        {sidebarCollapsed ? (
          <>
            {!isMacTitlebar() && <AppTitle compact />}
            <IconButton label="Mostrar a barra lateral" onClick={() => saveSidebar({ collapsed: false })}>
              <PanelLeftOpen size={16} />
            </IconButton>
            <div className="my-0.5 w-6 shrink-0 border-t border-border" />
            {studioActions.map((a) => (
              <IconButton key={a.id} label={a.title} onClick={a.onClick}>
                {a.icon}
              </IconButton>
            ))}
            {waitingCount > 0 && (
              <button
                className="mt-1 flex h-7 min-w-7 items-center justify-center gap-1 rounded-full bg-status-warn/20 px-1.5 text-[11px] font-bold text-status-warn ring-1 ring-status-warn/50 hover:bg-status-warn/30"
                title={`${waitingCount} agente(s) aguardando — clique para ir até o primeiro`}
                onClick={() => goPane(firstWaiting!)}
              >
                <span className="h-2 w-2 animate-pulse rounded-full bg-status-warn" />
                {waitingCount}
              </button>
            )}
          </>
        ) : (
          <div className="h-full">
            <div
              className="absolute -right-1 top-10 z-20 h-[calc(100%-2.5rem)] w-2 cursor-col-resize hover:bg-accent/40"
              title="Arraste para mudar a largura"
              onMouseDown={(e) => {
                e.preventDefault();
                const x0 = e.clientX;
                const w0 = sidebarWidth;
                let w = w0;
                const move = (ev: MouseEvent) => {
                  w = Math.max(200, Math.min(640, w0 + ev.clientX - x0));
                  setSidebarWidth(w);
                };
                const up = () => {
                  window.removeEventListener("mousemove", move);
                  window.removeEventListener("mouseup", up);
                  document.body.style.cursor = "";
                  saveSidebar({ width: w });
                };
                document.body.style.cursor = "col-resize";
                window.addEventListener("mousemove", move);
                window.addEventListener("mouseup", up);
              }}
              onDoubleClick={() => {
                setSidebarWidth(288);
                saveSidebar({ width: 288 });
              }}
            />
            {layout && act && (
              <Sidebar
                mode={(snap.settings?.sidebar?.view as SidebarMode) || modeLocal}
                onMode={(m) => {
                  setMode(m);
                  saveSidebar({ view: m });
                }}
                kindFilter={sidebarPrefs.kinds ?? []}
                tabTitle={(t) => L.tabDisplayName(t, layout.tabs.indexOf(t), (p) => {
                  const info = paneById.get(p);
                  return info ? paneIdentity({ title: info.title, kind_label: info.kind_label, tool: info.tool, stored: L.leaves(t.root).find((l) => l.leaf.pane === p)?.leaf.tool, screen: paneTools[p] ?? conn.lastScreenText(p) }, paneLabel(info)).name : undefined;
                }, focus[t.id] ?? null)}
                onKindFilter={(kinds) => saveSidebar({ kinds })}
                kindOrder={sidebarPrefs.kind_order}
                splitByKind={sidebarPrefs.split_by_kind !== false}
                onSplitByKind={(on) => saveSidebar({ split_by_kind: on })}
                onReopenClosed={reopenClosedAt}
                paneScreen={(pane) => paneTools[pane] ?? conn.lastScreenText(pane)}
                panes={snap.panes}
                layout={layout}
                focusedPane={focusedPane}
                onOpen={act.open}
                onOpenBeside={act.openBeside}
                onActivateTab={(id) => commit(L.setActive(layout, id))}
                onDropToTab={(pane, id) => act.dropOnTab(pane, id)}
                onRemoveGone={(tabId, path) => commit(L.removeLeafAt(layout, tabId, path))}
                onMenu={(pane, x, y) => {
                  setSplitMenu(null);
                  setMenu({ pane, x, y });
                }}
                agents={snap.agents}
                onGoAgent={goPane}
                onDismissAgent={(pane) => conn.dismissAgent(pane)}
                onCollapse={() => saveSidebar({ collapsed: true })}
                actions={studioActions}
                status={undefined}
                search={searchState}
                where={where}
                resultActions={resultActions!}
              />
            )}
          </div>
        )}
        </aside>
        </div>
        </div>

        <main className={cn("bt-main flex min-w-0 flex-1 flex-col", isMacTitlebar() && "bt-main-mac")}>
          {layout && act && (
            <TabBar
              layout={layout}
              onActivate={(id) => commit(L.setActive(layout, id))}
              onAdd={() => commit(L.addTab(layout, ""))}
              tabTitle={(t, i) => L.tabDisplayName(t, i, (p) => {
                const info = paneById.get(p);
                return info ? paneIdentity({ title: info.title, kind_label: info.kind_label, tool: info.tool, stored: L.leaves(t.root).find((l) => l.leaf.pane === p)?.leaf.tool, screen: paneTools[p] ?? conn.lastScreenText(p) }, paneLabel(info)).name : undefined;
              }, focus[t.id] ?? null)}
              paneScreen={(pane) => paneTools[pane] ?? conn.lastScreenText(pane)}
              onTool={(tabId, tool) => commit(L.setTabTool(layout, tabId, tool))}
              tabIdentity={(t) => {
                const ls = L.leaves(t.root).filter((l) => !l.leaf.gone);
                const pick = ls.find((l) => l.leaf.pane === focus[t.id]) ?? ls[0];
                const info = pick ? paneById.get(pick.leaf.pane) : undefined;
                if (!info) return { name: "" };
                return paneIdentity({ title: info.title, kind_label: info.kind_label, tool: info.tool, stored: pick.leaf.tool, screen: paneTools[pick.leaf.pane] ?? conn.lastScreenText(pick.leaf.pane) }, paneLabel(info));
              }}
              onRename={renameTabAndPanes}
              onClose={closeTabKeep}
              onReopenClosed={layout.closed?.length ? reopenClosed : undefined}
              onMoveTab={(id, to) => commit(L.moveTab(layout, id, to))}
              onDropPane={act.dropOnTab}
              onSearch={() => setPalette(true)}
              onGrid={() => setTermGrid(true)}
              filesOpen={filesOpen}
              onToggleFiles={() => {
                if (!activeTab) return;
                const flipped = toggleFolderPanel(filesNow, activeTab.id, activeTab.files_open === true);
                setFilesNow(flipped.next);
                if (layout) commit(L.setTabFilesOpen(layout, activeTab.id, flipped.open));
              }}
              onGeneral={() => openSettings("aparencia")}
              onTaskManager={() => setTaskManager(true)}
              onDatabase={openDatabase}
              onTools={() => setToolScreen("ssh")}
              onOpenFile={openFileDialog}
              onNewFile={() => newScratch(focusedFolder())}
              onSpeak={readOnly || focusedPane === null ? undefined : () => setSpeakPane(focusedPane)}
              hideActions
              waitingTabs={waitingTabs}
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={() => saveSidebar({ collapsed: !sidebarCollapsed })}
              alerts={
                <>
                  <CpuLimitButton conn={conn} limit={snap.cpuLimit} />
                  <AgentProcsBell conn={conn} items={snap.agentProcs} />
                </>
              }
              status={sidebarCollapsed ? connLed : undefined}
              onNewTab={() => setNewTab(true)}
              tabTerminal={tabTerminal}
            />
          )}
          {!restoreDismissed && restoreInfo && <RestoreBanner conn={conn} info={restoreInfo} onDismiss={() => setRestoreDismissed(true)} />}
          {snap.resumeOffers.length > 0 && <ResumeBanner conn={conn} offers={snap.resumeOffers} nameOf={(id) => storedName(id) || undefined} />}
          <div className={cn("bt-stage flex min-h-0 flex-1", filesOpen && "bt-stage-files")}>
          <div className="bt-term-frame flex min-h-0 min-w-0 flex-1 flex-col bg-bg-term">
            {hostBanner(snap.host, isMacTitlebar() ? "mac" : "windows") && (
              <HostBanner conn={conn} info={hostBanner(snap.host, isMacTitlebar() ? "mac" : "windows")!} />
            )}
            {!layout || !act ? (
              <div className="flex flex-1 items-center justify-center text-text-2">Carregando…</div>
            ) : !activeTab?.root ? (
              <EmptyTabBoard
                conn={conn}
                shells={snap.shells}
                panes={snap.panes}
                readOnly={readOnly}
                dragging={drag?.kind === "pane"}
                onDrop={(pane) => act.dropOnTab(pane, layout.active)}
                onOpen={(pane) => act.dropOnTab(pane, layout.active)}
                onSpawn={(shell) => {
                  const tab = layout.active;
                  conn
                    .spawn({ shell_id: shell.id })
                    .then((ev) => {
                      commit(L.movePaneToTab(layout, ev.pane_id, tab));
                      focusPane(tab, ev.pane_id);
                    })
                    .catch((e: Error) => setError(e.message));
                }}
                onOpenTools={(kind) => setToolScreen(kind)}
              />
            ) : (
              <SplitView
                node={activeTab.root}
                onSizes={(path, sizes, done) => commit(L.setSizes(layout, activeTab.id, path, sizes), done ? 0 : -1)}
                onDropPane={act.dropOnPane}
                renderGone={(pane, path, title, cwd) => (
                  <GoneLeaf key={`g${pane}`} title={title} cwd={cwd} onRemove={() => commit(L.removeLeafAt(layout, activeTab.id, path))} />
                )}
                renderLeaf={(pane, path, overlay) =>
                  L.isPlaceholder(pane) ? (
                    <OpeningLeaf key={pane} title={(L.nodeAt(activeTab.root, path) as L.LeafNode | null)?.title} />
                  ) : (
                    <TerminalView
                      key={pane}
                      conn={conn}
                      paneId={pane}
                      pane={paneById.get(pane)}
                      listLoaded={snap.panes !== null}
                      readOnly={readOnly}
                      settings={snap.settings}
                      focused={activeLeaves.length > 1 && pane === focusedPane}
                      canClose
                      onFocus={() => focusPane(activeTab.id, pane)}
                      onClose={() => act.unorganize(pane)}
                      onHeaderDragStart={(e) => startPaneDrag(e, pane)}
                      onHeaderDragEnd={endDrag}
                      onOrganize={(x, y) => {
                        setSplitMenu(null);
                        setMenu({ pane, x, y });
                      }}
                      onAskKill={readOnly ? undefined : () => setKillTarget({ pane, mode: "encerrar" })}
                      onDetach={readOnly || isRemote() ? undefined : () => act.detach(pane)}
                      onAskSeparate={readOnly ? undefined : () => setSeparateTarget(pane)}
                      onSpeak={readOnly ? undefined : () => setSpeakPane(pane)}
                      onSolo={activeLeaves.length > 1 ? () => act.moveToNewTab(pane) : undefined}
                      overlay={overlay}
                      flashKey={flash?.pane === pane ? flash.n : undefined}
                      agent={snap.agents[pane]}
                      aloneInHost={aloneInHostTab(snap.panes, pane)}
                      onDismissAgent={() => conn.dismissAgent(pane)}
                      onNewSplit={readOnly ? undefined : (zone, x, y) => {
                        setMenu(null);
                        setSplitMenu({ pane, x, y, zone });
                      }}
                      onOpenFile={setFilePreviewPath}
                      onAgentFolder={readOnly ? undefined : (dest) => openAgentFolder(pane, dest)}
                    />
                  )
                }
              />
            )}
          </div>
          {filesOpen && activeTab && (
            <div className="bt-side-slot bt-side-slot-right relative h-full min-h-0 shrink-0 self-stretch" style={{ width: filesWidth + 16, background: "rgb(19, 19, 19)" }}>
              <div
                className="absolute -left-1 top-2 z-20 h-[calc(100%-1rem)] w-2 cursor-col-resize hover:bg-accent/40"
                title="Arraste para mudar a largura da pasta"
                onMouseDown={(e) => {
                  e.preventDefault();
                  const x0 = e.clientX;
                  const w0 = filesWidth;
                  let w = w0;
                  const move = (ev: MouseEvent) => {
                    w = Math.max(200, Math.min(640, w0 - (ev.clientX - x0)));
                    setFilesWidth(w);
                  };
                  const up = () => {
                    window.removeEventListener("mousemove", move);
                    window.removeEventListener("mouseup", up);
                    document.body.style.cursor = "";
                    saveSidebar({ files_width: w });
                  };
                  document.body.style.cursor = "col-resize";
                  window.addEventListener("mousemove", move);
                  window.addEventListener("mouseup", up);
                }}
                onDoubleClick={() => {
                  setFilesWidth(308);
                  saveSidebar({ files_width: 308 });
                }}
              />
              <WorktreePanel
                key={activeTab.id}
                conn={conn}
                folder={focusedFolder()}
                folderLabel={focusedPane !== null ? shortCwd(paneById.get(focusedPane)?.cwd ?? "", 2) : ""}
                onClose={() => setFilesOpen(false)}
                onOpenFile={setFilePreviewPath}
              />
            </div>
          )}
          </div>
        </main>
      </div>

      <StartupOverlay
        conn={conn}
        socket={snap.socket}
        paneCount={snap.panes ? snap.panes.length : null}
        layoutReady={!!layout && !!act}
        allPanes={(snap.panes ?? []).map((x) => ({ id: x.pane_id, label: paneLabel(x) }))}
        activePanes={activeLeaves.filter((l) => !l.leaf.gone && !L.isPlaceholder(l.leaf.pane) && paneById.has(l.leaf.pane)).map((l) => l.leaf.pane)}
      />
      <ZoomBadge />
      {speakPane !== null && (
        <SpeakDialog
          conn={conn}
          pane={speakPane}
          info={paneById.get(speakPane)}
          onClose={() => {
            const target = speakPane;
            setSpeakPane(null);
            // foco de volta ao terminal (aba ativada, fim da tela) para o Enter
            returnFocus(target, () => act?.open(target));
          }}
          onOpenSettings={(section) => {
            setSpeakPane(null);
            openSettings(section ?? "voz");
          }}
          onSent={setNotice}
        />
      )}
      {voiceOpen && <VoiceSettingsDialog conn={conn} onClose={() => setVoiceOpen(false)} />}
      {separateTarget !== null && (
        <SeparateDialog
          conn={conn}
          pane={separateTarget}
          info={paneById.get(separateTarget)}
          onClose={() => setSeparateTarget(null)}
          onDone={setNotice}
        />
      )}
      {filePreviewPath && (
        <FilePreviewPanel
          key={panelKey}
          conn={conn}
          path={filePreviewPath}
          editOnOpen={editPath}
          onClose={() => setFilePreviewPath(null)}
          onOpen={setFilePreviewPath}
          onNewFile={newScratch}
          onSaveUntitled={(content) => setBrowser({ mode: "new-file", initial: untitledDir, content })}
        />
      )}
      {browser && (
        <FolderBrowser
          conn={conn}
          mode={browser.mode}
          initial={browser.initial}
          content={browser.content}
          onClose={() => setBrowser(null)}
          onPick={(p) => {
            if (browser.mode === "new-file") {
              // salvo: reabre o painel com o arquivo, ainda editando
              setPanelKey((k) => k + 1);
              setEditPath(p);
              setNotice(`Salvo em ${p}`);
            } else {
              setEditPath(null);
            }
            setFilePreviewPath(p);
            setBrowser(null);
          }}
        />
      )}
      {toolScreen && (
        <SshScreen
          conn={conn}
          readOnly={readOnly}
          initialTab={toolScreen}
          onConnect={async (kind, id, name) => {
            const pending = splitTool;
            if (pending) {
              const info = paneById.get(pending.pane);
              if (!info) throw new Error("o terminal de origem não está mais aberto");
              const pane = await splitAround(
                {
                  start: () => conn.spawnTool({ kind, id, window_id: info.window_id }),
                  getLayout,
                  commit,
                  timeoutMs: 20000,
                  untilListed,
                },
                info,
                pending.zone,
                name,
              );
              const at = getLayout() ? L.findPane(getLayout()!, pane) : null;
              if (at) focusPane(at.tabId, pane);
              setSplitTool(null);
              return;
            }
            const ev = await conn.spawnTool({ kind, id });
            setPendingSpawn({ pane: ev.pane_id, name, at: Date.now() }); // mesma aba nova do "Novo terminal"
          }}
          onClose={() => {
            setSplitTool(null);
            setToolScreen(null);
          }}
        />
      )}
      {taskManager && (
        <TaskManager
          conn={conn}
          onClose={() => setTaskManager(false)}
          onGoToPane={(id) => {
            setTaskManager(false);
            goPane(id); // mesma acao do clique na barra lateral
          }}
        />
      )}
      {killTarget !== null && (
        <KillDialog
          conn={conn}
          pane={killTarget.pane}
          info={paneById.get(killTarget.pane)}
          agent={snap.agents[killTarget.pane]}
          mode={killTarget.mode}
          onKilled={killTarget.mode === "matar" ? () => matarDone(killTarget.pane) : undefined}
          onRestart={killTarget.mode === "reiniciar" ? (end) => restartTerminal(killTarget.pane, end) : undefined}
          onClose={() => setKillTarget(null)}
        />
      )}
      {newTab && layout && (
        <NewTerminalDialog
          conn={conn}
          shells={snap.shells}
          focused={focusedPane !== null ? paneById.get(focusedPane) : undefined}
          readOnly={readOnly}
          onEmptyTab={() => commit(L.addTab(layout, ""))}
          onCreated={(pane, name) => setPendingSpawn({ pane, name, at: Date.now() })}
          onOpenTools={(kind) => {
            setNewTab(false);
            setSplitTool(null);
            setToolScreen(kind);
          }}
          onClose={() => setNewTab(false)}
        />
      )}
      {general && (
        <SettingsDialog
          conn={conn}
          catalog={catalog}
          settings={snap.settings}
          panes={snap.panes}
          defaultThemeId={defaultThemeId}
          onPreviewUI={setUIPreview}
          onClose={() => {
            setUIPreview(null);
            setGeneral(false);
          }}
          onMessage={setNotice}
          notify={notifyPrefs}
          onNotify={setNotifyPrefs}
          sidebar={sidebarPrefs}
          saveSidebar={saveSidebar}
          initialSection={generalSection}
        />
      )}
      {!isRemote() && <RemoteConnectedBadge conn={conn} onOpen={() => openSettings("celular")} />}
      {notice && (
        <div className="pointer-events-none fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 rounded bg-bg-card px-3 py-1.5 text-text-1 shadow-lg ring-1 ring-border">
          {notice}
        </div>
      )}
      {termGrid && layout && act && (
        <TerminalGrid
          conn={conn}
          panes={snap.panes ?? []}
          layout={layout}
          kindOrder={sidebarPrefs.kind_order}
          onClose={() => setTermGrid(false)}
          onOpen={(c) => {
            setTermGrid(false);
            if (c.state === "gone") {
              if (c.tabId) commit(L.setActive(layout, c.tabId));
              return;
            }
            act.open(c.pane);
            setFlash((f) => ({ pane: c.pane, n: (f?.n ?? 0) + 1 }));
          }}
          onOpenBeside={(c) => {
            setTermGrid(false);
            act.openBeside(c.pane);
            setFlash((f) => ({ pane: c.pane, n: (f?.n ?? 0) + 1 }));
          }}
        />
      )}
      {palette && resultActions && (
        <SearchPalette s={searchState} panes={snap.panes ?? []} where={where} actions={resultActions} onClose={() => setPalette(false)} />
      )}
      {splitMenu && !readOnly && (
        <SplitShellMenu
          pane={paneById.get(splitMenu.pane)}
          x={splitMenu.x}
          y={splitMenu.y}
          zone={splitMenu.zone}
          shells={snap.shells}
          requestShells={requestShells}
          onPick={(zone, id, label) => newSplit(splitMenu.pane, zone, id, label)}
          onOpenTool={(zone, kind) => {
            setSplitTool({ pane: splitMenu.pane, zone });
            setToolScreen(kind);
            setSplitMenu(null);
          }}
          onClose={() => setSplitMenu(null)}
        />
      )}
      {menu && layout && menuActions && (
        <PaneMenu
          pane={menu.pane}
          x={menu.x}
          y={menu.y}
          layout={layout}
          panes={snap.panes ?? []}
          actions={menuActions}
          onClose={() => setMenu(null)}
          initialView={menu.view}
          tabTitle={tabTitleOf}
        />
      )}
    </div>
  );
}

/** Lugar do terminal que o Beth Studio esta' criando ("abrindo…"). */
function OpeningLeaf({ title }: { title?: string }) {
  return (
    <section className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 overflow-hidden rounded-md border border-dashed border-border-strong bg-bg-panel text-text-2">
      <Loader2 size={20} className="animate-spin text-accent-text" />
      <div className="text-[13px]">Abrindo {title || "terminal"}…</div>
    </section>
  );
}

function Banner({ tone, children, onClose }: { tone: "err" | "warn"; children: ReactNode; onClose?: () => void }) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[12px]",
        false && "mt-7",
        tone === "err" ? "border-status-err/30 bg-status-err/10 text-status-err" : "border-status-warn/30 bg-status-warn/10 text-status-warn",
      )}
      onMouseDown={(e) => {
        if (!isMacTitlebar() || e.button !== 0) return;
        if ((e.target as Element).closest("button")) return;
        dragMacWindow();
      }}
    >
      <AlertTriangle size={14} className="shrink-0" />
      <div className="flex-1">{children}</div>
      {onClose && (
        <button className="rounded p-0.5 hover:bg-white/10" onClick={onClose} title="Fechar aviso">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/** Ponto de 8 px com o estado da conexao (substitui a barra do topo). */
function ConnLed({ socket, status, readOnly, onClick }: { socket: string; status: StatusEvent | null; readOnly: boolean; onClick: () => void }) {
  const up = socket === "open" && status?.state === "up";
  const busy = socket === "connecting" || (socket === "open" && (!status || status.state === "starting"));
  const tip = up
    ? "Conectado ao Beth Studio — clique para atualizar a lista"
    : busy
      ? "Conectando ao Beth Studio…"
      : `${socket !== "open" ? "Sem conexão com o bethstudio-web" : status?.message || "Beth Studio indisponível"} — clique para reconectar`;
  return (
    <button
      className="fixed right-3 top-3 z-40 flex h-6 w-6 items-center justify-center rounded-full hover:bg-bg-hover"
      title={tip + (readOnly ? " · somente leitura" : "")}
      onClick={onClick}
    >
      <span className={`h-2 w-2 rounded-full ${up ? "bg-status-ok" : busy ? "animate-pulse bg-status-busy" : "bg-status-err"}`} />
      {readOnly && <Lock size={12} className="text-status-warn" />}
    </button>
  );
}
