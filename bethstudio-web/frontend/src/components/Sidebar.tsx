import { useMemo, useState, type DragEvent as RDragEvent, type ReactNode } from "react";
import {
  AppWindow,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Columns2,
  Folder,
  FolderTree,
  Inbox,
  LayoutGrid,
  Loader2,
  MessageCircleQuestion,
  PanelLeftClose,
  Shapes,
  Trash2,
  X,
} from "lucide-react";
import type { PaneInfo } from "@/lib/types";
import { groupPanes, paneLabel } from "@/lib/panes";
import { groupByFolder, splitCwd } from "@/lib/folders";
import { findPane, leaves, looseByClosedGroup, type Layout, type Path, type WebTab } from "@/lib/layout";
import { PANE_MIME, draggedPane, endDrag, startPaneDrag } from "@/lib/dnd";
import { cn } from "@/lib/utils";
import { isOriginalStyle, useOriginalStyle } from "@/lib/uiStyle";
import { IconButton } from "./IconButton";
import { AppTitle } from "./AppTitle";
import type { StudioAction } from "./StudioActions";
import { AgentBadge, KindIcon } from "./KindIcon";
import { ToolIcon } from "./ToolIcon";
import { paneIdentity } from "@/lib/paneIdentity";
import { isMacTitlebar } from "@/lib/windowFrame";
import { AGENT_FILTER, KIND_LABEL, countKinds, groupByKind, passesKindFilter, visibleKindOrder } from "@/lib/kinds";
import type { SearchResult } from "@/lib/search";
import { AgentDot } from "./AgentDot";
import { agentChatPhase, reasonLabel, waitingList, type AgentInfo, type AgentState } from "@/lib/agents";
import type { NotifyPrefs } from "@/lib/notify";
import { SearchInput, SearchResults, type ResultActions } from "./SearchResults";
import type { SearchState } from "@/lib/useSearch";

export type SidebarMode = "web" | "host" | "kind" | "folder";

interface Props {
  mode: SidebarMode;
  onMode: (m: SidebarMode) => void;
  panes: PaneInfo[] | null;
  layout: Layout;
  focusedPane: number | null;
  onOpen: (pane: number) => void;
  onOpenBeside: (pane: number) => void;
  /** Tira o terminal da aba (ele continua rodando em Não organizados). */
  onClosePane?: (pane: number) => void;
  onActivateTab: (tabId: string) => void;
  onDropToTab: (pane: number, tabId: string) => void;
  onRemoveGone: (tabId: string, path: Path) => void;
  onMenu: (pane: number, x: number, y: number) => void;
  search: SearchState;
  where: (pane: number, gone: boolean) => string;
  resultActions: ResultActions;
  agents: AgentState;
  onGoAgent: (pane: number) => void;
  onDismissAgent: (pane: number) => void;
  onCollapse: () => void;
  /** botoes de ferramenta (SSH, arquivos, tarefas, banco, configuracoes...) */
  actions?: StudioAction[];
  /** LED da conexao (fica na faixa do titulo) */
  status?: ReactNode;
  /** filtro por tipo (multisselecao; vazio = todos) */
  kindFilter: string[];
  onKindFilter: (sel: string[]) => void;
  /** nome exibido da aba do web */
  tabTitle?: (t: WebTab) => string;
  /** lista completa, sem o filtro de tipo (interno) */
  allPanes?: PaneInfo[] | null;
  /** ordem dos grupos de tipo (vazio = padrao) */
  kindOrder?: string[];
  /** "Separar por tipo" em Nao organizados / Como no Beth Studio */
  splitByKind: boolean;
  onSplitByKind: (on: boolean) => void;
  /** reabre o grupo fechado (aba fechada) de indice i */
  onReopenClosed: (index: number) => void;
  /** Texto da tela do pane, para o nome e o ícone baterem com a aba. */
  paneScreen?: (pane: number) => string | undefined;
  /** Avisos do sistema (aguardar / pronto); opcional na lista. */
  notify?: NotifyPrefs;
  onNotify?: (p: NotifyPrefs) => void;
}

export function Sidebar(p0: Props) {
  // O filtro por tipo vale para as tres visoes e para a busca.
  const filtered = useMemo(
    () => (p0.panes ? p0.panes.filter((x) => passesKindFilter(x, p0.kindFilter)) : null),
    [p0.panes, p0.kindFilter],
  );
  const p = { ...p0, panes: filtered, allPanes: p0.panes };
  const acceptResult = (r: SearchResult) => {
    if (r.entry.gone) return p0.kindFilter.length === 0;
    const info = p0.panes?.find((x) => x.pane_id === r.entry.pane);
    return !!info && passesKindFilter(info, p0.kindFilter);
  };
  const shownResults = p.search.results.filter(acceptResult);
  const orig = useOriginalStyle();
  return (
    <div className="flex h-full flex-col">
      {!isMacTitlebar() && <AppTitle right={p0.status} />}
      {p0.actions && p0.actions.length > 0 && (
        <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-2 py-1">
          {p0.actions
            .filter((a) => a.id !== "search") // a busca ja' esta logo abaixo
            .map((a) => (
              <IconButton key={a.id} label={a.title} onClick={a.onClick}>
                {a.icon}
              </IconButton>
            ))}
        </div>
      )}
      <div className="border-b border-border px-2 py-2">
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <SearchInput s={p.search} compact inputId="beth-search" />
          </div>
          <IconButton label="Recolher a barra lateral" onClick={p.onCollapse}>
            <PanelLeftClose size={15} />
          </IconButton>
        </div>
        {orig && <KindChips panes={p0.panes ?? []} selected={p0.kindFilter} onChange={p0.onKindFilter} order={p0.kindOrder} />}
        <WaitingBar {...p0} />
        {p0.onNotify && p0.notify && (
          <label className="mt-1.5 flex cursor-pointer items-center gap-2 px-0.5 text-[11px] text-text-2 hover:text-text-1">
            <input
              type="checkbox"
              className="accent-[rgb(var(--bt-accent))]"
              checked={p0.notify.os || p0.notify.ready}
              onChange={(e) => {
                const on = e.target.checked;
                p0.onNotify!({ ...p0.notify!, os: on, ready: on });
              }}
            />
            Notificar no sistema (aguardar e pronto)
          </label>
        )}
      </div>
      {!orig && (
        <div className="px-2 pt-2">
          <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-text-3">Ver</div>
        </div>
      )}
      <div className={cn(orig ? "grid grid-cols-2 gap-1 p-2" : "grid grid-cols-2 gap-1 px-2", p.search.query.trim() && "hidden")}>
        <ModeButton active={p.mode === "web"} onClick={() => p.onMode("web")} icon={<LayoutGrid size={13} />}>
          Minha organização
        </ModeButton>
        <ModeButton active={p.mode === "host"} onClick={() => p.onMode("host")} icon={<AppWindow size={13} />}>
          Como no Beth Studio
        </ModeButton>
        <ModeButton active={p.mode === "kind"} onClick={() => p.onMode("kind")} icon={<Shapes size={13} />}>
          Por tipo
        </ModeButton>
        <ModeButton active={p.mode === "folder"} onClick={() => p.onMode("folder")} icon={<FolderTree size={13} />}>
          Por pasta
        </ModeButton>
      </div>
      {!orig && (
        <div className="px-2 pb-1 pt-2">
          <KindChips panes={p0.panes ?? []} selected={p0.kindFilter} onChange={p0.onKindFilter} order={p0.kindOrder} />
        </div>
      )}
      {(p.mode === "web" || p.mode === "host") && !p.search.query.trim() && (
        <label
          className={orig ? "-mt-1 flex cursor-pointer items-center gap-1.5 px-3 pb-1 text-[11px] text-text-2" : "flex cursor-pointer items-center gap-1.5 px-3 pb-1.5 text-[11px] text-text-2"}
          title={/Mac/.test(navigator.platform) ? "Subdivide a lista por tipo de terminal (Container, SSH…)" : "Subdivide a lista por tipo de terminal (WSL, PowerShell, SSH…)"}
        >
          <input type="checkbox" checked={p.splitByKind} onChange={(e) => p.onSplitByKind(e.target.checked)} />
          Separar a lista por tipo
        </label>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!p.panes ? (
          <div className="p-4 text-text-2">Buscando terminais…</div>
        ) : p.search.query.trim() ? (
          <div className="p-1.5">
            <div className="px-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-text-2">
              Resultados <span className="font-normal text-text-3">({shownResults.length})</span>
              {p0.kindFilter.length > 0 && <span className="ml-1 font-normal normal-case text-text-3">· com filtro de tipo</span>}
            </div>
            <SearchResults s={{ ...p.search, results: shownResults }} panes={p0.panes ?? []} where={p.where} actions={p.resultActions} />
          </div>
        ) : p.mode === "web" ? (
          <WebTree {...p} panes={p.panes} hideGone={p0.kindFilter.length > 0} />
        ) : p.mode === "kind" ? (
          <KindTree {...p} panes={p.panes} />
        ) : p.mode === "folder" ? (
          <FolderTreeView {...p} panes={p.panes} />
        ) : (
          <HostTree {...p} panes={p.panes} />
        )}
      </div>
    </div>
  );
}

function ModeButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: ReactNode; children: ReactNode }) {
  if (isOriginalStyle()) {
    // Estilo Original (0.4.1): botões baixos, ícone e texto na mesma linha.
    return (
      <button
        className={cn(
          "flex flex-1 items-center justify-center gap-1 rounded px-1.5 py-1 text-[11px] leading-tight",
          active ? "bg-accent text-white" : "bg-bg-card text-text-2 hover:text-text-1",
        )}
        onClick={onClick}
      >
        {icon}
        {children}
      </button>
    );
  }
  return (
    <button
      className={cn(
        // Sem bg-accent/bg-hover: com vibrancy a tinta é só a placa nativa.
        "bt-mode bt-glass flex min-h-16 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 text-[11px] leading-tight",
        active ? "bt-glass-on text-white" : "text-text-2 hover:text-text-1",
      )}
      onClick={onClick}
    >
      {icon}
      <span className="min-w-0 whitespace-normal text-center leading-tight">{children}</span>
    </button>
  );
}

/** "Minha organizacao": abas do web e os terminais de cada uma. */
function WebTree(p: Props & { panes: PaneInfo[]; hideGone?: boolean }) {
  const byId = useMemo(() => new Map(p.panes.map((x) => [x.pane_id, x])), [p.panes]);
  const [over, setOver] = useState<string | null>(null);
  const organized = new Set<number>();
  for (const t of p.layout.tabs) for (const l of leaves(t.root)) if (!l.leaf.gone) organized.add(l.leaf.pane);
  const loose = p.panes.filter((x) => !organized.has(x.pane_id)).sort((a, b) => a.pane_id - b.pane_id);

  const dropProps = (key: string, onDrop: (pane: number) => void) => ({
    onDragOver: (e: RDragEvent) => {
      if (!e.dataTransfer.types.includes(PANE_MIME)) return;
      e.preventDefault();
      setOver(key);
    },
    onDragLeave: () => setOver((o) => (o === key ? null : o)),
    onDrop: (e: RDragEvent) => {
      e.preventDefault();
      setOver(null);
      const pane = draggedPane(e);
      endDrag();
      if (pane !== null) onDrop(pane);
    },
  });

  return (
    <nav className="flex flex-col gap-2 px-2 pb-3">
      {p.layout.tabs.map((t) => {
        const ls = leaves(t.root).filter(({ leaf }) => leaf.pane >= 0); // sem os "abrindo…"
        return (
          <div key={t.id} className={cn("rounded-md", over === t.id && "bg-accent-soft ring-1 ring-accent")} {...dropProps(t.id, (pane) => p.onDropToTab(pane, t.id))}>
            <button
              className={cn(
                "flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-[11px] font-medium uppercase tracking-wide",
                t.id === p.layout.active ? "text-text-2" : "text-text-3 hover:text-text-2",
              )}
              onClick={() => p.onActivateTab(t.id)}
              title="Abrir esta aba (solte um terminal aqui para movê-lo para ela)"
            >
              <LayoutGrid size={12} className="shrink-0" />
              <span className="truncate" title={p.tabTitle ? p.tabTitle(t) : t.name}>
                {p.tabTitle ? p.tabTitle(t) : t.name}
              </span>
              {ls.some(({ leaf }) => !leaf.gone && p.agents[leaf.pane]) && (
                <AgentDot agent={ls.map(({ leaf }) => p.agents[leaf.pane]).find(Boolean)!} />
              )}
              <span className="ml-auto font-normal text-text-3">{ls.length}</span>
            </button>
            {ls.length === 0 && <div className="px-2 pb-1 pl-6 text-[11px] text-text-3">vazia — arraste terminais para cá</div>}
            <ul className="flex flex-col gap-1.5 pl-2">
              {ls.map(({ leaf, path }) => {
                const info = leaf.gone ? undefined : byId.get(leaf.pane);
                // com filtro de tipo: some o que nao passa (e os encerrados)
                if (!info && (p.hideGone || (!leaf.gone && p.allPanes?.some((x) => x.pane_id === leaf.pane)))) return null;
                if (!info) {
                  return (
                    <li key={`g-${path.join(".")}`} className="flex items-start gap-2 rounded-md px-2 py-1.5 opacity-60">
                      <span className="mt-[5px] h-2 w-2 shrink-0 rounded-full border border-text-3" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] text-text-2 line-through decoration-text-3">{leaf.title || `Terminal ${leaf.pane}`}</div>
                        <div className="truncate text-[11px] text-text-3">terminal encerrado</div>
                      </div>
                      <IconButton label="Remover da organização" onClick={() => p.onRemoveGone(t.id, path)} className="h-6 w-6">
                        <Trash2 size={13} />
                      </IconButton>
                    </li>
                  );
                }
                return (
                  <PaneItem
                    key={leaf.pane}
                    agent={p.agents[leaf.pane]}
                    info={info}
                    screen={p.paneScreen?.(leaf.pane)}
                    stored={leaf.tool}
                    focused={p.focusedPane === leaf.pane && t.id === p.layout.active}
                    open
                    onClick={() => p.onOpen(leaf.pane)}
                    onClose={p.onClosePane ? () => p.onClosePane!(leaf.pane) : undefined}
                    onMenu={(x, y) => p.onMenu(leaf.pane, x, y)}
                  />
                );
              })}
            </ul>
          </div>
        );
      })}
      <div>
        <div className="flex items-center gap-1.5 px-1.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-2">
          <Inbox size={12} /> Não organizados <span className="ml-auto font-normal text-text-3">{loose.length}</span>
        </div>
        {loose.length === 0 && <div className="px-2 pl-6 text-[11px] text-text-3">todos os terminais estão em alguma aba</div>}
        {looseByClosedGroup(p.layout, loose.map((x) => x.pane_id)).map((g) => {
          const ps = g.panes.map((id) => byId.get(id)!).filter(Boolean);
          const item = (x: PaneInfo) => (
            <PaneItem
              key={x.pane_id}
              agent={p.agents[x.pane_id]}
              info={x}
              screen={p.paneScreen?.(x.pane_id)}
              stored={storedTool(p.layout, x.pane_id)}
              focused={false}
              open={false}
              onClick={() => p.onOpen(x.pane_id)}
              onBeside={() => p.onOpenBeside(x.pane_id)}
              onMenu={(cx, cy) => p.onMenu(x.pane_id, cx, cy)}
            />
          );
          if (g.group)
            return (
              <div key={`g${g.group.id}`} className="mb-1 rounded-md border border-dashed border-border px-0.5 pb-0.5">
                <div className="flex items-center gap-1.5 px-1.5 py-0.5 text-[10px] text-text-3">
                  <span className="min-w-0 flex-1 truncate" title="Estes terminais estavam juntos numa aba que foi fechada">
                    antes na aba “{g.group.name || "sem nome"}”
                  </span>
                  <button
                    className="shrink-0 rounded px-1.5 py-0.5 text-accent-text hover:bg-bg-hover"
                    onClick={() => p.onReopenClosed(g.index)}
                    title="Reabre a aba com estes terminais, no mesmo layout"
                  >
                    Reabrir aba
                  </button>
                </div>
                <ul className="flex flex-col gap-1.5">{ps.map(item)}</ul>
              </div>
            );
          return p.splitByKind ? (
            <KindSections key="rest" panes={ps} order={p.kindOrder} render={item} compact />
          ) : (
            <ul key="rest" className="flex flex-col gap-1.5">
              {ps.map(item)}
            </ul>
          );
        })}
      </div>
    </nav>
  );
}

/** "Como no Beth Studio": janela -> aba -> pane do host. */
function HostTree(p: Props & { panes: PaneInfo[] }) {
  const groups = useMemo(() => groupPanes(p.panes), [p.panes]);
  if (p.panes.length === 0) return <div className="p-4 text-text-2">Nenhum terminal aberto no BethStudio.</div>;
  return (
    <nav className="flex flex-col gap-2 px-2 pb-3">
      {groups.map((w) => (
        <div key={w.windowId}>
          <div className="flex items-center gap-1.5 px-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-text-2">
            <AppWindow size={12} className="shrink-0" />
            <span className="truncate" title={w.label}>
              {w.label}
            </span>
          </div>
          {p.splitByKind && (
            <KindSections panes={w.tabs.flatMap((t) => t.panes)} order={p.kindOrder} render={(x) => <LoosePane key={x.pane_id} p={p} x={x} />} compact />
          )}
          {!p.splitByKind && w.tabs.map((t) => (
            <div key={t.tabId} className="mb-1">
              {w.tabs.length > 1 && (
                <div className="truncate px-2 pb-0.5 pl-5 text-[11px] text-text-3" title={t.label}>
                  {t.label}
                </div>
              )}
              <ul className="flex flex-col gap-1.5">
                {t.panes.map((x) => {
                  const where = findPane(p.layout, x.pane_id);
                  const wt = where ? p.layout.tabs.find((tt) => tt.id === where.tabId) : undefined;
                  const tabName = wt ? (p.tabTitle ? p.tabTitle(wt) : wt.name) : undefined;
                  return (
                    <PaneItem
                      key={x.pane_id}
                      agent={p.agents[x.pane_id]}
                      info={x}
                      screen={p.paneScreen?.(x.pane_id)}
                      stored={storedTool(p.layout, x.pane_id)}
                      focused={p.focusedPane === x.pane_id}
                      open={!!where}
                      badge={tabName}
                      onClick={() => p.onOpen(x.pane_id)}
                      onBeside={where ? undefined : () => p.onOpenBeside(x.pane_id)}
                      onClose={where && p.onClosePane ? () => p.onClosePane!(x.pane_id) : undefined}
                      onMenu={(cx, cy) => p.onMenu(x.pane_id, cx, cy)}
                    />
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </nav>
  );
}

function storedTool(layout: Layout, pane: number): string | undefined {
  for (const t of layout.tabs) {
    const hit = leaves(t.root).find((l) => l.leaf.pane === pane);
    if (hit?.leaf.tool) return hit.leaf.tool;
  }
  return undefined;
}

function PaneItem(p: {
  agent?: AgentInfo;
  info: PaneInfo;
  focused: boolean;
  open: boolean;
  badge?: string;
  onClick: () => void;
  onBeside?: () => void;
  onClose?: () => void;
  onMenu: (x: number, y: number) => void;
  /** "Por pasta": a pasta ja' esta' no cabecalho do grupo */
  hideCwd?: boolean;
  /** Texto da tela, para o nome e o ícone baterem com a aba. */
  screen?: string;
  /** Ferramenta gravada na aba, a mesma que a faixa de abas usa. */
  stored?: string;
}) {
  const x = p.info;
  const id = paneIdentity({ title: x.title, kind_label: x.kind_label, tool: x.tool, agent: x.agent_name, screen: p.screen, stored: p.stored }, paneLabel(x));
  const sidebarName = id.tool === "codex" ? "Codex" : id.name;
  const cwd = p.hideCwd ? { parent: "", name: "" } : splitCwd(x.cwd);
  const phase = agentChatPhase({
    title: x.title,
    screen: p.screen,
    agentName: x.agent_name,
    agentFlag: x.agent,
    waiting: !!p.agent,
  });
  const phaseLabel =
    phase === "waiting" ? "aguardando você" : phase === "running" ? "rodando…" : phase === "ready" ? "pronto" : null;
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        draggable
        onDragStart={(e) => startPaneDrag(e, x.pane_id)}
        onDragEnd={endDrag}
        onClick={p.onClick}
        onContextMenu={(e) => {
          e.preventDefault();
          p.onMenu(e.clientX, e.clientY);
        }}
        className={cn(
          isOriginalStyle()
            ? cn(
                // Estilo Original (0.4.1): linha compacta com a borda da esquerda.
                "group flex cursor-pointer items-start gap-2 rounded-md border-l-2 px-2 py-1.5",
                p.focused ? "border-accent bg-accent-soft" : p.open ? "border-accent/60 bg-bg-card hover:bg-bg-hover" : "border-transparent hover:bg-bg-hover",
              )
            : cn("bt-chat group flex min-h-10 cursor-pointer items-start gap-2.5 rounded-2xl px-2.5 py-2", p.focused ? "bt-glass-on" : "hover:bg-bg-hover"),
          phase === "waiting" && !p.focused && "ring-1 ring-status-warn/35",
          phase === "running" && !p.focused && "ring-1 ring-status-busy/30",
        )}
        title={`${paneLabel(x)}${x.cwd ? ` — ${x.cwd}` : ""}${phaseLabel ? ` — ${phaseLabel}` : ""}`}
      >
        {phase === "waiting" && p.agent ? (
          <AgentDot agent={p.agent} className="mt-1.5" />
        ) : phase === "running" ? (
          <span className="relative mt-1.5 inline-flex h-2.5 w-2.5 shrink-0" title="Chat rodando">
            <span className="absolute inset-0 animate-ping rounded-full bg-status-busy opacity-50" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-status-busy" />
          </span>
        ) : phase === "ready" ? (
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-status-ok" title="Chat pronto" />
        ) : (
          <span
            className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", x.is_active ? "bg-status-ok" : "bg-border-strong")}
            title={x.is_active ? "Pane ativo na aba do Beth Studio" : "Pane inativo"}
          />
        )}
        {/* Logo do agente fica; loading / espera / pronto vão abaixo dela. */}
        <span className="mt-0.5 flex w-4 shrink-0 flex-col items-center gap-0.5" title={phaseLabel ?? undefined}>
          {id.tool ? <ToolIcon tool={id.tool} size={14} /> : <KindIcon pane={x} />}
          {phase === "running" && <Loader2 size={12} className="animate-spin text-status-busy" strokeWidth={2.75} aria-hidden />}
          {phase === "waiting" && <MessageCircleQuestion size={11} className="text-status-warn" strokeWidth={2.5} aria-hidden />}
          {phase === "ready" && <CheckCircle2 size={11} className="text-status-ok" strokeWidth={2.5} aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className={cn("truncate text-[13px] text-text-1", p.focused && "font-semibold")}>{sidebarName}</span>
            {(x.agent_name || x.agent) && <AgentBadge name={x.agent_name} />}
          </div>
          {cwd.name && (
            <div className="truncate font-mono text-[11px] text-text-3" title={x.cwd}>
              {cwd.name}
            </div>
          )}
          {p.badge && (
            <div className={cn("mt-0.5 truncate text-[10px]", p.focused ? "text-white/85" : "text-accent-text")}>
              na aba “{p.badge}”
            </div>
          )}
          {phaseLabel && (
            <div
              className={cn(
                "mt-0.5 truncate text-[10px] font-semibold",
                phase === "waiting" && "text-status-warn",
                phase === "running" && "text-status-busy",
                phase === "ready" && "text-status-ok",
              )}
            >
              {phaseLabel}
            </div>
          )}
        </div>
        {p.onBeside && (
          <IconButton
            label="Abrir ao lado do terminal em foco"
            onClick={p.onBeside}
            className={cn("h-7 w-7 opacity-60 group-hover:opacity-100", p.focused && "text-white/85 hover:bg-white/15 hover:text-white")}
          >
            <Columns2 size={14} />
          </IconButton>
        )}
        {p.onClose && (
          <IconButton
            label="Tirar da aba — o terminal continua em Não organizados"
            onClick={p.onClose}
            className={cn(
              "h-7 w-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
              p.focused && "bg-white/15 text-white opacity-90 hover:bg-white/25",
            )}
          >
            <X size={14} />
          </IconButton>
        )}
      </div>
    </li>
  );
}

/** "N aguardando": lista dos terminais com agente esperando o usuario. */
function WaitingBar(p: Props) {
  const [open, setOpen] = useState(false);
  const alive = new Set((p.panes ?? []).map((x) => x.pane_id));
  const list = waitingList(p.agents, alive);
  if (list.length === 0) return null;
  const byId = new Map((p.panes ?? []).map((x) => [x.pane_id, x]));
  return (
    <div className="mt-1.5">
      <button
        className="flex w-full items-center gap-2 rounded bg-status-warn/15 px-2 py-1 text-left text-[12px] font-semibold text-status-warn ring-1 ring-status-warn/40 hover:bg-status-warn/25"
        onClick={() => setOpen((v) => !v)}
        title="Terminais com um agente esperando resposta — clique para ver"
      >
        <AgentDot agent={list[0]} />
        {list.length} aguardando
        <span className="ml-auto text-[11px] font-normal">{open ? "fechar" : "ver"}</span>
      </button>
      {open && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {list.map((a) => {
            const info = byId.get(a.pane);
            return (
              <li key={a.pane} className="group flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-bg-hover">
                <button className="min-w-0 flex-1 text-left" onClick={() => p.onGoAgent(a.pane)} title={`Ir até o terminal (${reasonLabel(a)})`}>
                  <div className="truncate text-[12px] text-text-1">{info ? paneLabel(info) : `Terminal ${a.pane}`}</div>
                  <div className="truncate text-[10px] text-text-3">{reasonLabel(a)}</div>
                </button>
                <button
                  className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-text-2 hover:bg-bg-card hover:text-text-1"
                  title="Dispensar este aviso"
                  onClick={() => p.onDismissAgent(a.pane)}
                >
                  dispensar
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Chips de filtro por tipo (multisselecao) com contagem. */
function KindChips({ panes, selected, onChange, order }: { panes: PaneInfo[]; selected: string[]; onChange: (s: string[]) => void; order?: string[] }) {
  const c = countKinds(panes);
  const toggle = (k: string) => onChange(selected.includes(k) ? selected.filter((x) => x !== k) : [...selected, k]);
  // Estilo Original (0.4.1): pílulas com fundo; Mac: texto com placa de vidro.
  const orig = isOriginalStyle();
  const chip = (key: string, label: ReactNode, n: number, title: string) => (
    <button
      key={key}
      className={
        orig
          ? cn(
              "flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]",
              selected.includes(key) ? "bg-accent text-white" : "bg-bg-card text-text-2 hover:text-text-1",
            )
          : cn(
              // Selecionado: bt-glass-on → placa nativa; sem text-accent (segunda tinta).
              "bt-chip flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11px]",
              selected.includes(key) ? "bt-glass-on font-semibold text-white" : "text-text-2 hover:text-text-1",
            )
      }
      onClick={() => toggle(key)}
      title={title}
    >
      {label}
      <span className={cn("text-[10px]", selected.includes(key) ? "text-white/85" : "text-text-3")}>{n}</span>
    </button>
  );
  const kinds = visibleKindOrder(order);
  return (
    <div className={orig ? "mt-2 flex flex-wrap gap-1" : "flex flex-wrap gap-1"}>
      <button
        className={
          orig
            ? cn("rounded-full px-2 py-0.5 text-[11px]", selected.length === 0 ? "bg-accent text-white" : "bg-bg-card text-text-2 hover:text-text-1")
            : cn(
                "bt-chip rounded-lg px-2 py-0.5 text-[11px]",
                selected.length === 0 ? "bt-glass-on font-semibold text-white" : "text-text-2 hover:text-text-1",
              )
        }
        onClick={() => onChange([])}
        title="Mostrar todos os tipos"
      >
        Todos <span className="text-[10px] opacity-80">{panes.length}</span>
      </button>
      {kinds.filter((k) => c[k] > 0 || selected.includes(k)).map((k) => chip(k, KIND_LABEL[k], c[k], `Mostrar ${KIND_LABEL[k]} (clique de novo para tirar)`))}
      {(c.agent > 0 || selected.includes(AGENT_FILTER)) &&
        chip(
          AGENT_FILTER,
          <>
            <Bot size={11} /> Agentes
          </>,
          c.agent,
          "Só terminais com agente (Claude Code etc.) — combina com os tipos",
        )}
    </div>
  );
}

/** "Por tipo": grupos WSL / PowerShell / cmd / SSH ... recolhiveis. */
function KindTree(p: Props & { panes: PaneInfo[] }) {
  if (p.panes.length === 0) return <div className="p-4 text-text-2">Nenhum terminal com esse filtro.</div>;
  return (
    <nav className="flex flex-col gap-2 px-2 pb-3">
      <KindSections panes={p.panes} order={p.kindOrder} render={(x) => <LoosePane key={x.pane_id} p={p} x={x} />} />
    </nav>
  );
}

/** "Por pasta": um grupo por pasta atual (muda com o cd), recolhiveis. */
function FolderTreeView(p: Props & { panes: PaneInfo[] }) {
  const groups = useMemo(() => groupByFolder(p.panes), [p.panes]);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  if (p.panes.length === 0) return <div className="p-4 text-text-2">Nenhum terminal com esse filtro.</div>;
  const toggle = (k: string) => setClosed((c) => ({ ...c, [k]: !c[k] }));
  return (
    <nav className="flex flex-col gap-2 px-2 pb-3">
      {groups.map((g) => (
        <div key={g.key}>
          <button
            className="bt-folder flex w-full min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[13px] font-semibold text-text-1 hover:text-accent-text"
            onClick={() => toggle(g.key)}
            title={`${g.path || "Terminais sem pasta conhecida"}\n${closed[g.key] ? "Mostrar o grupo" : "Recolher o grupo"}`}
          >
            {closed[g.key] ? <ChevronRight size={12} className="shrink-0" /> : <ChevronDown size={12} className="shrink-0" />}
            <Folder size={13} className="shrink-0 text-accent-text" />
            <span className="truncate">{g.label}</span>
            {g.panes.some((x) => p.agents[x.pane_id]) && <AgentDot agent={g.panes.map((x) => p.agents[x.pane_id]).find(Boolean)!} />}
            <span className="ml-auto shrink-0 text-[11px] font-normal text-text-3">{g.panes.length}</span>
          </button>
          {!closed[g.key] && <ul className="flex flex-col gap-1.5">{g.panes.map((x) => <LoosePane key={x.pane_id} p={p} x={x} hideCwd />)}</ul>}
        </div>
      ))}
    </nav>
  );
}

/** Um terminal na lista (com a aba do web onde ele esta', se estiver). */
function LoosePane({ p, x, hideCwd }: { p: Props; x: PaneInfo; hideCwd?: boolean }) {
  const where = findPane(p.layout, x.pane_id);
  const wt = where ? p.layout.tabs.find((tt) => tt.id === where.tabId) : undefined;
  const tabName = wt ? (p.tabTitle ? p.tabTitle(wt) : wt.name) : undefined;
  return (
    <PaneItem
      agent={p.agents[x.pane_id]}
      info={x}
      screen={p.paneScreen?.(x.pane_id)}
      stored={storedTool(p.layout, x.pane_id)}
      focused={p.focusedPane === x.pane_id}
      open={!!where}
      badge={tabName}
      onClick={() => p.onOpen(x.pane_id)}
      onBeside={where ? undefined : () => p.onOpenBeside(x.pane_id)}
      onClose={where && p.onClosePane ? () => p.onClosePane!(x.pane_id) : undefined}
      onMenu={(cx, cy) => p.onMenu(x.pane_id, cx, cy)}
      hideCwd={hideCwd}
    />
  );
}

/**
 * Lista separada por tipo, na ordem configurada (WSL por distro, SSH por
 * host), com cabecalhos recolhiveis. `compact` = cabecalhos menores (dentro
 * de "Nao organizados" / de uma janela do host).
 */
function KindSections({ panes, order, render, compact }: { panes: PaneInfo[]; order?: string[]; render: (x: PaneInfo) => ReactNode; compact?: boolean }) {
  const sections = useMemo(() => groupByKind(panes, order), [panes, order]);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setClosed((c) => ({ ...c, [k]: !c[k] }));
  return (
    <>
      {sections.map((s) => (
        <div key={s.key}>
          <button
            className={cn(
              "bt-folder flex w-full items-center gap-1.5 rounded-lg px-1.5 text-left font-semibold text-text-2 hover:text-text-1",
              compact ? "py-0.5 pl-3 text-[10px] uppercase tracking-wide" : "py-1 text-[11px] uppercase tracking-wide",
            )}
            onClick={() => toggle(s.key)}
            title={closed[s.key] ? "Mostrar o grupo" : "Recolher o grupo"}
          >
            {closed[s.key] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            {s.key === AGENT_FILTER ? <Bot size={12} className="shrink-0" /> : <KindIcon pane={s.panes[0]} size={12} />}
            {s.label}
            <span className="ml-auto font-normal text-text-3">{s.panes.length}</span>
          </button>
          {!closed[s.key] &&
            (s.distros ? (
              s.distros.map((d) => (
                <div key={d.distro} className="mb-1">
                  <div className="truncate px-2 pb-0.5 pl-6 text-[11px] text-text-3">
                    {s.group === "ssh" ? `SSH · ${d.distro}` : d.distro} <span className="text-text-3/70">({d.panes.length})</span>
                  </div>
                  <ul className="flex flex-col gap-1.5">{d.panes.map(render)}</ul>
                </div>
              ))
            ) : (
              <ul className="flex flex-col gap-1.5">{s.panes.map(render)}</ul>
            ))}
        </div>
      ))}
    </>
  );
}
