import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AlertTriangle, Lock, PanelLeftOpen, Search as SearchIcon, Settings as SettingsIcon, TerminalSquare, X } from "lucide-react";
import { Connection } from "@/lib/connection";
import { loadCatalog } from "@/lib/appearance";
import type { PaneInfo, SettingsEvent, StatusEvent } from "@/lib/types";
import * as L from "@/lib/layout";
import { beginExternalPaneDrag, dispatchPaneDrag, endDrag, startPaneDrag, useDrag, draggedPane, PANE_MIME } from "@/lib/dnd";
import { pointInPage, shouldCloseAfterDrop, toCssPoint } from "@/lib/termDrop";
import { Sidebar, type SidebarMode } from "@/components/Sidebar";
import { TerminalView } from "@/components/TerminalView";
import { IconButton } from "@/components/IconButton";
import { TabBar } from "@/components/TabBar";
import { buildStudioActions } from "@/components/StudioActions";
import { GoneLeaf, SplitView } from "@/components/SplitView";
import { PaneMenu, type PaneMenuActions } from "@/components/PaneMenu";
import { SearchPalette } from "@/components/SearchPalette";
import type { ResultActions } from "@/components/SearchResults";
import { useSearch } from "@/lib/useSearch";
import { SettingsDialog, type SettingsSection } from "@/components/SettingsDialog";
import { NewTerminalDialog } from "@/components/NewTerminalDialog";
import { SplitShellMenu } from "@/components/SplitShellMenu";
import { TaskManager } from "@/components/TaskManager";
import { FilePreviewPanel } from "@/components/FilePreviewPanel";
import { FolderBrowser, type FolderBrowserMode } from "@/components/FolderBrowser";
import { UNTITLED_PATH } from "@/lib/folderBrowser";
import { StartupOverlay } from "@/components/StartupOverlay";
import { resolveLinkPath } from "@/lib/localFile";
import { installLinkGuard } from "@/lib/links";
import { SshScreen, type ToolKind } from "@/components/SshScreen";
import { TopResizeEdges } from "@/components/WindowControls";
import { AppTitle } from "@/components/AppTitle";
import { TooltipLayer } from "@/components/TooltipLayer";
import { useWindowState } from "@/lib/windowFrame";
import { isRemote, openRemoteTab } from "@/lib/remote";
import { RemoteConnectedBadge } from "@/components/RemoteStudioSection";
import { returnFocus, withTabFocus } from "@/lib/termFocus";
import { splitAround, splitSpawn, type SplitZone } from "@/lib/splitSpawn";
import { Loader2 } from "lucide-react";
import { KillDialog } from "@/components/KillDialog";
import { SeparateDialog } from "@/components/SeparateDialog";
import { SpeakDialog } from "@/components/SpeakDialog";
import { VoiceSettingsDialog } from "@/components/VoiceSettingsDialog";
import { useAgentAlerts, useNotifyPrefs } from "@/lib/notify";
import { aloneInHostTab } from "@/lib/hostFit";
import { paneLabel } from "@/lib/panes";
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

const OLD_VIEWS_KEY = "bethterm-web.views"; // organizacao antiga (so' migracao)
const MODE_KEY = "bethterm-web.sidebar";

function openParam(): number[] {
  const q = new URLSearchParams(window.location.search).get("open");
  return (q ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => s(n));
  function s(n: number) {
    return Number.isInteger(n) && n >= 0;
  }
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
function useWebLayout(settings: SettingsEvent | null, panes: PaneInfo[] | null, onError: (m: string) => void) {
  const [layout, setLayout] = useState<L.Layout | null>(null);
  const localJSON = useRef("");
  const pending = useRef(0);
  const localOnly = useRef(false); // mudanca local ainda nao enviada (arrastando divisoria)
  const timer = useRef<number | undefined>(undefined);
  const openedParam = useRef(false);

  const save = useCallback(
    (l: L.Layout) => {
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
    [onError],
  );

  /** delay: 0 = grava ja'; >0 = agrupa (arrastar divisoria); -1 = so' local */
  const current = useRef<L.Layout | null>(null);
  current.current = layout;
  const commit = useCallback(
    (l: L.Layout, delay = 0) => {
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
    [save],
  );

  useEffect(() => {
    if (!settings || !panes) return;
    const server = settings.layout ? L.sanitize(settings.layout) : null;
    if (!server) {
      if (layout) return;
      // Primeira vez (ou arquivo da versao anterior): monta a aba
      // "Principal" com o que estava aberto antes.
      let l = L.emptyLayout();
      const alive = new Set(panes.map((p) => p.pane_id));
      const ids = openParam().length ? openParam() : oldViews();
      for (const id of ids) if (alive.has(id)) l = L.movePaneToTab(l, id, l.active);
      openedParam.current = true;
      commit(l);
      return;
    }
    let next = server;
    if (!openedParam.current) {
      openedParam.current = true;
      const alive = new Set(panes.map((p) => p.pane_id));
      for (const id of openParam()) if (alive.has(id)) next = L.movePaneToTab(next, id, next.active);
      if (next !== server) {
        commit(next);
        return;
      }
    }
    const js = JSON.stringify(server);
    if (pending.current === 0 && !localOnly.current && js !== localJSON.current) {
      localJSON.current = js;
      setLayout(server);
    }
  }, [settings, panes, layout, commit]);

  const getLayout = useCallback(() => current.current, []);
  return { layout, commit, getLayout };
}

export function App() {
  const snap = useSyncExternalStore(conn.subscribe, conn.getSnapshot);
  const drag = useDrag();
  const [error, setError] = useState<string | null>(null);
  const onError = useCallback((m: string) => setError(m), []);
  const { layout, commit: rawCommit, getLayout } = useWebLayout(snap.settings, snap.panes, onError);
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
  const [killTarget, setKillTarget] = useState<number | null>(null);
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

  // --- acoes -----------------------------------------------------------
  // "Abrir arquivo…": janela do Windows, começando na pasta do terminal em foco
  // pasta do terminal em foco, como caminho do Windows (\\wsl.localhost\... no WSL)
  const focusedFolder = () => {
    const p = focusedPane !== null ? paneById.get(focusedPane) : undefined;
    return p?.cwd
      ? (resolveLinkPath(p.cwd, { paneKind: p.kind, paneWsl: p.wsl, paneDistro: p.wsl_distro || p.distro, paneCwd: p.cwd }) ?? "")
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
          reject(new Error("o terminal foi criado, mas ainda não apareceu na lista do BethTerm"));
          return;
        }
        window.setTimeout(tick, 40);
      };
      tick();
    });
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
        commit(next);
        focusPane(layout.active, pane);
      },
      moveToTab(pane: number, tabId: string) {
        commit(L.movePaneToTab(layout, pane, tabId));
      },
      moveToNewTab(pane: number) {
        commit(L.addTab(layout, storedName(pane), pane));
      },
      splitWith(target: number, other: number, zone: Exclude<L.Zone, "center">) {
        const l = ensureIn(layout, target);
        commit(L.dropOnPane(l, other, target, zone));
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
        commit(L.dropOnPane(layout, pane, target, zone));
        const at = L.findPane(layout, target);
        if (at) focusPane(at.tabId, pane);
      },
      dropOnTab(pane: number, tabId: string | null) {
        if (tabId === null) commit(L.addTab(layout, "", pane));
        else commit(L.movePaneToTab(layout, pane, tabId));
      },
    };
    return a;
  }, [layout, commit, focusedPane]);

  // Terminal destacado: o Go manda onde esta' o cursor enquanto a janela nativa
  // e' arrastada; aqui o arrasto vira eventos de drag da pagina, e as zonas de
  // soltar (paineis, abas, "+") funcionam como no arrasto da lista.
  const termDragLast = useRef<Element | null>(null);
  useEffect(
    () =>
      conn.onTermDrag((e) => {
        const closeWindow = () => void conn.api("/api/term/close", { pane_id: e.pane }).catch(() => undefined);
        const l = getLayout();
        if (e.attach) {
          // botao "Encaixar" da janela: vai para a aba ativa
          if (!l) return;
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
        askKill: readOnly ? undefined : (pane: number) => setKillTarget(pane),
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

  // Abas do web com algum agente aguardando.
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
  };
  const [sidebarLocal, setSidebarLocal] = useState<SidebarPrefs | null>(null);
  const sidebarPrefs: SidebarPrefs = sidebarLocal ?? snap.settings?.sidebar ?? { collapsed: false, width: 288 };
  const sidebarCollapsed = sidebarPrefs.collapsed;
  const [dragWidth, setSidebarWidth] = useState<number | null>(null);
  const sidebarWidth = dragWidth ?? sidebarPrefs.width ?? 288;
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
        setError("O terminal foi criado, mas ainda não apareceu na lista do BethTerm. Procure em Não organizados.");
      },
      Math.max(0, 8000 - (Date.now() - pendingSpawn.at)),
    );
    return () => window.clearTimeout(t);
  }, [pendingSpawn, layout, snap.panes, commit]);

  return (
    <div className="flex h-full flex-col bg-bg-body text-text-1">
      <TopResizeEdges state={winState} />
      <TooltipLayer />
      {/* Avisos */}
      {snap.socket === "closed" && (
        <Banner tone="err">
          Sem conexão com o bethterm-web. Tentando reconectar…
          <button className="ml-3 rounded bg-white/10 px-2 py-0.5 hover:bg-white/20" onClick={() => conn.reconnectNow()}>
            Reconectar agora
          </button>
        </Banner>
      )}
      {bridgeDown && <Banner tone="warn">{snap.status?.message || "Ponte com o BethTerm indisponível."}</Banner>}
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
        {sidebarCollapsed ? (
          <aside className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-bg-panel pb-2">
            <AppTitle compact />
            <IconButton label="Mostrar a barra lateral" onClick={() => saveSidebar({ collapsed: false })}>
              <PanelLeftOpen size={16} />
            </IconButton>
            <IconButton label="Buscar terminal" onClick={() => setPalette(true)}>
              <SearchIcon size={16} />
            </IconButton>
            <IconButton label="Configurações" onClick={() => openSettings("aparencia")}>
              <SettingsIcon size={16} />
            </IconButton>
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
          </aside>
        ) : (
          <aside className="relative shrink-0 border-r border-border bg-bg-panel" style={{ width: sidebarWidth }}>
            <div
              className="absolute -right-1 top-0 z-20 h-full w-2 cursor-col-resize hover:bg-accent/40"
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
                  return info ? paneLabel(info) : undefined;
                }, focus[t.id] ?? null)}
                onKindFilter={(kinds) => saveSidebar({ kinds })}
                kindOrder={sidebarPrefs.kind_order}
                splitByKind={sidebarPrefs.split_by_kind !== false}
                onSplitByKind={(on) => saveSidebar({ split_by_kind: on })}
                onReopenClosed={reopenClosedAt}
                panes={snap.panes}
                layout={layout}
                focusedPane={focusedPane}
                onOpen={act.open}
                onOpenBeside={act.openBeside}
                onActivateTab={(id) => commit(L.setActive(layout, id))}
                onDropToTab={(pane, id) => act.dropOnTab(pane, id)}
                onRemoveGone={(tabId, path) => commit(L.removeLeafAt(layout, tabId, path))}
                onMenu={(pane, x, y) => setMenu({ pane, x, y })}
                agents={snap.agents}
                onGoAgent={goPane}
                onDismissAgent={(pane) => conn.dismissAgent(pane)}
                onCollapse={() => saveSidebar({ collapsed: true })}
                actions={studioActions}
                status={connLed}
                search={searchState}
                where={where}
                resultActions={resultActions!}
              />
            )}
          </aside>
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          {layout && act && (
            <TabBar
              layout={layout}
              onActivate={(id) => commit(L.setActive(layout, id))}
              onAdd={() => commit(L.addTab(layout, ""))}
              tabTitle={(t, i) => L.tabDisplayName(t, i, (p) => {
                const info = paneById.get(p);
                return info ? paneLabel(info) : undefined;
              }, focus[t.id] ?? null)}
              onRename={renameTabAndPanes}
              onClose={closeTabKeep}
              onReopenClosed={layout.closed?.length ? reopenClosed : undefined}
              onMoveTab={(id, to) => commit(L.moveTab(layout, id, to))}
              onDropPane={act.dropOnTab}
              onSearch={() => setPalette(true)}
              onGeneral={() => openSettings("aparencia")}
              onTaskManager={() => setTaskManager(true)}
              onDatabase={openDatabase}
              onTools={() => setToolScreen("ssh")}
              onOpenFile={openFileDialog}
              onNewFile={() => newScratch(focusedFolder())}
              onSpeak={readOnly || focusedPane === null ? undefined : () => setSpeakPane(focusedPane)}
              hideActions={!sidebarCollapsed}
              waitingTabs={waitingTabs}
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={() => saveSidebar({ collapsed: !sidebarCollapsed })}
              status={sidebarCollapsed ? connLed : undefined}
              onNewTab={() => setNewTab(true)}
            />
          )}
          <div className="flex min-h-0 flex-1 p-2">
            {!layout || !act ? (
              <div className="flex flex-1 items-center justify-center text-text-2">Carregando…</div>
            ) : !activeTab?.root ? (
              <EmptyTab dragging={drag?.kind === "pane"} onDrop={(pane) => act.dropOnTab(pane, layout.active)} />
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
                      onOrganize={(x, y) => setMenu({ pane, x, y })}
                      onAskKill={readOnly ? undefined : () => setKillTarget(pane)}
                      onDetach={readOnly || isRemote() ? undefined : () => act.detach(pane)}
                      onAskSeparate={readOnly ? undefined : () => setSeparateTarget(pane)}
                      onSpeak={readOnly ? undefined : () => setSpeakPane(pane)}
                      onSolo={activeLeaves.length > 1 ? () => act.moveToNewTab(pane) : undefined}
                      overlay={overlay}
                      flashKey={flash?.pane === pane ? flash.n : undefined}
                      agent={snap.agents[pane]}
                      aloneInHost={aloneInHostTab(snap.panes, pane)}
                      onDismissAgent={() => conn.dismissAgent(pane)}
                      onNewSplit={readOnly ? undefined : (zone, x, y) => setSplitMenu({ pane, x, y, zone })}
                      onOpenFile={setFilePreviewPath}
                    />
                  )
                }
              />
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
          pane={killTarget}
          info={paneById.get(killTarget)}
          agent={snap.agents[killTarget]}
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

/** Lugar do terminal que o BethTerm esta' criando ("abrindo…"). */
function OpeningLeaf({ title }: { title?: string }) {
  return (
    <section className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 overflow-hidden rounded-md border border-dashed border-border-strong bg-bg-panel text-text-2">
      <Loader2 size={20} className="animate-spin text-accent-text" />
      <div className="text-[13px]">Abrindo {title || "terminal"}…</div>
    </section>
  );
}

function EmptyTab({ dragging, onDrop }: { dragging: boolean; onDrop: (pane: number) => void }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`flex flex-1 flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed text-text-2 ${
        over ? "border-accent bg-accent-soft" : dragging ? "border-border-strong" : "border-transparent"
      }`}
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
      <TerminalSquare size={36} className="text-text-3" />
      <div className="text-[15px] text-text-1">Aba vazia</div>
      <div>Clique num terminal à esquerda ou arraste-o para cá.</div>
    </div>
  );
}

function Banner({ tone, children, onClose }: { tone: "err" | "warn"; children: ReactNode; onClose?: () => void }) {
  return (
    <div
      className={
        "flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[12px] " +
        (tone === "err" ? "border-status-err/30 bg-status-err/10 text-status-err" : "border-status-warn/30 bg-status-warn/10 text-status-warn")
      }
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
    ? "Conectado ao BethTerm — clique para atualizar a lista"
    : busy
      ? "Conectando ao BethTerm…"
      : `${socket !== "open" ? "Sem conexão com o bethterm-web" : status?.message || "BethTerm indisponível"} — clique para reconectar`;
  return (
    <button
      className="mb-0.5 flex h-7 shrink-0 items-center gap-1.5 rounded px-1.5 hover:bg-bg-hover"
      title={tip + (readOnly ? " · somente leitura" : "")}
      onClick={onClick}
    >
      <span className={`h-2 w-2 rounded-full ${up ? "bg-status-ok" : busy ? "animate-pulse bg-status-busy" : "bg-status-err"}`} />
      {readOnly && <Lock size={12} className="text-status-warn" />}
    </button>
  );
}
