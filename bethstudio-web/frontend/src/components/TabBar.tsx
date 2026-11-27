import { useEffect, useLayoutEffect, useRef, useState, type DragEvent as RDragEvent, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  RotateCcw,
  Pencil,
  Plus,
  Power,
  RotateCw,
  Type,
  X,
} from "lucide-react";
import { dragMacWindow, isFrameless, isMacTitlebar, startDrag, useWindowState, winCommand, zoomMacWindow } from "@/lib/windowFrame";
import { ICON_W, labelWidth, planBarActions, tabLabel } from "@/lib/tabBarLayout";
import { WindowControls } from "./WindowControls";
import { GlassMenu, MenuItem, MenuRule } from "./GlassMenu";
import { buildStudioActions, type StudioAction } from "./StudioActions";
import type { Layout, WebTab } from "@/lib/layout";
import { countLeaves, leaves } from "@/lib/layout";
import { PANE_MIME, TAB_MIME, dragEndedOutside, draggedPane, endDrag, startTabDrag, useDrag } from "@/lib/dnd";
import { ToolIcon } from "./ToolIcon";
import { cn } from "@/lib/utils";
import { useOriginalStyle } from "@/lib/uiStyle";

interface Props {
  layout: Layout;
  onActivate: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onClose: (id: string) => void;
  /** "Reabrir aba fechada" (ausente = nada para reabrir) */
  onReopenClosed?: () => void;
  onMoveTab: (id: string, toIndex: number) => void;
  /** soltar um terminal no titulo da aba (ou no "+", tabId = null) */
  onDropPane: (pane: number, tabId: string | null) => void;
  /** arrastou a guia para fora da janela → vira janela(s) destacada(s) */
  onTearOffTab?: (tabId: string) => void;
  /** abre a paleta "ir para terminal" */
  onSearch: () => void;
  /** popup com todos os terminais em grade (prints, nome, caminho), inclusive os sem aba */
  onGrid?: () => void;
  /** pasta da guia ativa (arquivos e git), à direita */
  filesOpen?: boolean;
  onToggleFiles?: () => void;
  /** Gerenciador de tarefas (memoria, CPU, GPU, disco, terminais, WSL) */
  onTaskManager?: () => void;
  /** painel Banco de dados */
  onDatabase?: () => void;
  /** tela SSH e Serial (hosts salvos, arquivos, portas COM) */
  onTools?: () => void;
  /** "Novo arquivo": cria um .md/.txt numa pasta escolhida e abre para editar */
  onNewFile?: () => void;
  /** abre "Aparencia geral" */
  onGeneral: () => void;
  /** abas do web com algum agente aguardando */
  waitingTabs: Set<string>;
  /** "+ Nova aba" abre o popup "Novo terminal" (null = so' cria aba vazia) */
  onNewTab?: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar?: () => void;
  /** nome exibido (o do usuario ou o do terminal) */
  tabTitle: (t: WebTab, index: number) => string;
  /** Ferramenta e texto da tela do pane, os mesmos campos da lista. */
  tabIdentity?: (t: WebTab) => { name: string; tool?: string };
  /** Pede o texto da tela, para achar a ferramenta quando o título não diz. */
  paneScreen?: (pane: number) => string | undefined;
  /** Grava a ferramenta na aba, para o ícone continuar quando a aba fecha. */
  onTool?: (tabId: string, tool: string) => void;
  /** LED da conexao (fica a' direita) */
  status?: ReactNode;
  /** microfone para o terminal em foco (ausente = sem botao) */
  onSpeak?: () => void;
  /** os botoes de ferramenta estao na barra lateral (nao repetir aqui) */
  hideActions?: boolean;
  /** avisos com ícone (processos deixados pelos agentes), à direita das abas */
  alerts?: ReactNode;
  /**
   * "Matar terminal…" / "Reiniciar este terminal…" do terminal em foco da aba
   * (null = aba sem terminal vivo ou somente leitura). `restartBlocked`: por que nao da' para reiniciar.
   */
  tabTerminal?: (tabId: string) => { onKill: () => void; onRestart?: () => void; restartBlocked?: string } | null;
}

/** Abas do web (so' do web: nao mudam nada no Beth Studio). */
export function TabBar({
  layout,
  onActivate,
  onAdd,
  onRename,
  onClose,
  onReopenClosed,
  onMoveTab,
  onDropPane,
  onTearOffTab,
  onSearch,
  onGrid,
  filesOpen,
  onToggleFiles,
  onTaskManager,
  onDatabase,
  onTools,
  onNewFile,
  onGeneral,
  waitingTabs,
  onNewTab,
  sidebarCollapsed,
  onToggleSidebar,
  alerts,
  tabTitle,
  tabIdentity,
  paneScreen: _paneScreen,
  onTool,
  status,
  onSpeak,
  hideActions,
  tabTerminal,
}: Props) {
  const drag = useDrag();
  const [editing, setEditing] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  useEffect(() => {
    if (!drag) setOver(null);
  }, [drag]);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const win = useWindowState();
  const frameless = isFrameless();
  // macOS: os botões do sistema ocupam a esquerda da faixa de abas.
  const macBar = isMacTitlebar();
  // Estilo Original (0.4.1): abas baixas e retas; Mac: abas em pílula.
  const orig = useOriginalStyle();
  // largura da barra -> quais acoes mostram texto / vao para o "…"
  const barRef = useRef<HTMLDivElement>(null);
  const [barW, setBarW] = useState(1400);
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBarW(el.clientWidth));
    ro.observe(el);
    setBarW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  // abas: rolagem horizontal com setas quando nao cabem
  const tabsRef = useRef<HTMLDivElement>(null);
  const [scrollL, setScrollL] = useState(false);
  const [scrollR, setScrollR] = useState(false);
  const checkScroll = () => {
    const el = tabsRef.current;
    if (!el) return;
    setScrollL(el.scrollLeft > 1);
    setScrollR(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };
  useEffect(() => {
    checkScroll();
    const el = tabsRef.current;
    const active = el?.querySelector<HTMLElement>("[data-tab-active]");
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
    checkScroll();
  }, [layout, barW]);
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    if (!moreOpen) return;
    const close = () => setMoreOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [moreOpen]);

  const acts: StudioAction[] = hideActions ? [] : buildStudioActions({ onSearch, onGeneral, onTaskManager, onDatabase, onTools, onNewFile, onSpeak });
  // o que fica fixo: icone, recolher, minimo das abas, "Nova aba", area de arraste, LED, botoes da janela
  const newTabLabel = false; // acoes sempre so' icone (produto para devs)
  const reserved = (frameless ? 30 + 138 : 0) + 32 + 190 + (newTabLabel ? labelWidth("Nova aba") : ICON_W) + (onGrid ? 34 : 0) + 56 + 20 + 16;
  const plan = planBarActions(barW - reserved, acts);
  const actById = new Map(acts.map((a) => [a.id, a]));

  const accepts = (e: RDragEvent) => e.dataTransfer.types.includes(PANE_MIME) || e.dataTransfer.types.includes(TAB_MIME);

  return (
    <div
      ref={barRef}
      data-term-drop="tabs"
      className={cn(
        orig
          ? "flex h-7 shrink-0 items-end gap-0.5 overflow-hidden border-b border-border px-2 pt-1 select-none"
          : // overflow visible: a curva invertida da aba ativa sai ~20 px para
            // cada lado; hidden cortava a da direita (junto do +).
            "bt-tabstrip flex h-10 shrink-0 items-center overflow-visible px-1.5 select-none",
        macBar && sidebarCollapsed && "pl-8",
        macBar && "bt-tabstrip-mac",
        frameless && !win.active && "opacity-75",
      )}
      onMouseDown={(e) => {
        if (macBar) {
          if (e.button !== 0 || e.detail > 1) return;
          const t = e.target as Element | null;
          if (t && t !== e.currentTarget && t.closest("button,input,[data-no-drag],[draggable=true],.bt-tab,.bt-tab-tool")) return;
          e.preventDefault();
          dragMacWindow();
          return;
        }
        startDrag(e);
      }}
      onDoubleClick={(e) => {
        if ((e.target as Element).closest("button,input,[draggable=true],[data-no-drag]")) return;
        if (macBar) {
          zoomMacWindow();
          return;
        }
        if (!frameless) return;
        winCommand("toggle");
      }}
    >
      {orig && (
        <button
          className="mb-0.5 mr-1 flex h-5 w-7 shrink-0 items-center justify-center rounded text-text-2 hover:bg-bg-hover hover:text-text-1"
          title={sidebarCollapsed ? "Mostrar a barra lateral" : "Recolher a barra lateral"}
          onClick={onToggleSidebar}
        >
          {sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
        </button>
      )}
      {orig && scrollL && (
        <button
          className="mb-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-2 hover:bg-bg-hover"
          title="Abas à esquerda"
          onClick={() => tabsRef.current?.scrollBy({ left: -240, behavior: "smooth" })}
        >
          <ChevronLeft size={14} />
        </button>
      )}
      <div className={orig ? "contents" : "relative flex min-w-0 shrink self-stretch overflow-visible"}>
      <div
        ref={tabsRef}
        onScroll={checkScroll}
        className={
          orig
            ? "flex min-w-[120px] shrink items-end gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            : "flex items-center overflow-x-auto pl-5 pr-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        }
      >
        {layout.tabs.map((t, i) => {
          const active = t.id === layout.active;
          const n = countLeaves(t.root);
          return (
            <div
              key={t.id}
              draggable={editing !== t.id}
              onDragStart={(e) => startTabDrag(e, t.id)}
              onDragEnd={(e) => {
                const id = t.id;
                const outside = dragEndedOutside(e);
                endDrag();
                if (outside && onTearOffTab) onTearOffTab(id);
              }}
              onDragOver={(e) => {
                if (!accepts(e)) return;
                e.preventDefault();
                setOver(t.id);
              }}
              onDragLeave={() => setOver((o) => (o === t.id ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const tab = e.dataTransfer.getData(TAB_MIME);
                if (tab) onMoveTab(tab, i);
                else {
                  const p = draggedPane(e);
                  if (p !== null) onDropPane(p, t.id);
                }
                endDrag();
              }}
              onClick={() => onActivate(t.id)}
              onDoubleClick={() => setEditing(t.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ id: t.id, x: e.clientX, y: e.clientY });
              }}
              data-tab-active={active ? "" : undefined}
              className={
                orig
                  ? cn(
                      "group flex h-6 min-w-[96px] max-w-[220px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-3 text-[12.5px]",
                      active ? "border-border bg-bg-panel text-text-1" : "border-transparent text-text-2 hover:bg-bg-hover hover:text-text-1",
                      over === t.id && "border-accent bg-accent-soft text-text-1",
                      drag?.kind === "pane" && !active && "border-dashed border-border-strong",
                    )
                  : cn(
                      "bt-tab group flex shrink-0 cursor-pointer items-center gap-1.5 text-[12.5px]",
                      active && "bt-tab-active",
                      over === t.id && "bt-tab-over",
                    )
              }
              title={`${tabTitle(t, i)} — ${n} terminal(is)`}
            >
              {(() => {
                const id = tabIdentity?.(t);
                const stored = leaves(t.root).map((l) => l.leaf.tool).find((s) => s);
                if (id?.tool && id.tool !== stored) onTool?.(t.id, id.tool);
                const name = tabLabel(t.name, id, tabTitle(t, i));
                return (
                  <>
                    {id?.tool ? <ToolIcon tool={id.tool as React.ComponentProps<typeof ToolIcon>["tool"]} size={14} /> : null}
                    {editing === t.id ? (
                      <RenameBox
                        initial={t.name || name}
                        onDone={(v) => {
                          setEditing(null);
                          if (v === null) return;
                          if (!t.name && v.trim() === name) return;
                          onRename(t.id, v);
                        }}
                      />
                    ) : (
                      <span className={cn("truncate", !t.name && "italic")}>{name}</span>
                    )}
                  </>
                );
              })()}
              {waitingTabs.has(t.id) && (
                <span className="relative inline-flex h-2 w-2 shrink-0" title="Um agente nesta aba aguarda sua resposta">
                  <span className="absolute inset-0 animate-ping rounded-full bg-status-warn opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-status-warn" />
                </span>
              )}
              {/* Só com 2+ terminais: evita “Aba 2” + “0/1” parecer “Aba 20/21”. */}
              {orig ? (
                <span className="shrink-0 rounded bg-bg-hover px-1 text-[10px] text-text-3">{n}</span>
              ) : (
                n > 1 && (
                  <span className="bt-tab-count" title={`${n} terminais nesta guia`}>
                    {n}
                  </span>
                )
              )}
              {!orig && <span className="min-w-2 flex-1" />}
              <button
                className={
                  orig
                    ? cn("shrink-0 rounded p-0.5 hover:bg-bg-card", active ? "text-text-2" : "text-transparent group-hover:text-text-2")
                    : "bt-tab-close"
                }
                title={n > 0 ? "Fechar aba — os terminais continuam rodando em Não organizados" : "Fechar aba"}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
              >
                <X size={orig ? 12 : 14} />
              </button>
            </div>
          );
        })}
      </div>
      </div>
      {orig && scrollR && (
        <button
          className="mb-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-2 hover:bg-bg-hover"
          title="Abas à direita"
          onClick={() => tabsRef.current?.scrollBy({ left: 240, behavior: "smooth" })}
        >
          <ChevronRight size={14} />
        </button>
      )}
      {/* Enquanto arrasta um terminal: slot pontilhado “nova guia” (kanban). */}
      {!orig && drag?.kind === "pane" && (
        <div
          className={cn("bt-tab-ghost", over === "+" && "bt-tab-ghost-hot")}
          aria-hidden
        >
          nova guia
        </div>
      )}
      <button
        className={
          orig
            ? cn(
                "ml-0.5 flex h-6 w-8 shrink-0 items-center justify-center self-center rounded text-text-2 hover:bg-bg-hover hover:text-text-1",
                over === "+" && "bg-accent-soft text-text-1 ring-1 ring-accent",
              )
            : cn("bt-tab-tool bt-tab-tool-plus", over === "+" && "bt-tab-tool-over")
        }
        aria-label="Nova aba"
        title={
          onNewTab
            ? "Nova aba: criar um terminal no Beth Studio ou uma aba vazia (solte um terminal aqui para abri-lo numa aba nova)"
            : "Nova aba (solte um terminal aqui para abri-lo numa aba nova)"
        }
        onClick={onNewTab ?? onAdd}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(PANE_MIME)) return;
          e.preventDefault();
          setOver("+");
        }}
        onDragLeave={() => setOver((o) => (o === "+" ? null : o))}
        onDrop={(e) => {
          e.preventDefault();
          setOver(null);
          const p = draggedPane(e);
          if (p !== null) onDropPane(p, null);
          endDrag();
        }}
      >
        <Plus size={16} strokeWidth={orig ? 2 : 2.25} />
        {newTabLabel && "Nova aba"}
      </button>
      {onGrid && (
        <button
          className={orig ? "flex h-6 w-8 shrink-0 items-center justify-center self-center rounded text-text-2 hover:bg-bg-hover hover:text-text-1" : "bt-tab-tool"}
          aria-label="Ver todas as abas"
          title="Ver todas as abas: grade com print, nome e pasta de cada terminal, com busca (inclui os de abas fechadas)"
          onClick={onGrid}
        >
          <LayoutGrid size={15} strokeWidth={2} />
        </button>
      )}
      {onToggleFiles && (
        <button
          className={cn(orig ? "flex h-6 w-8 shrink-0 items-center justify-center self-center rounded text-text-2 hover:bg-bg-hover hover:text-text-1" : "bt-tab-tool", filesOpen && "text-text-1")}
          aria-label="Pasta desta guia"
          aria-pressed={filesOpen}
          title="Pasta desta guia: arquivos e mudanças de git do terminal em foco. Cada guia abre e fecha a sua."
          onClick={onToggleFiles}
        >
          <PanelRight size={15} strokeWidth={2} />
        </button>
      )}
      <div
        className="h-full min-w-[48px] flex-1"
        onMouseDown={startDrag}
        onDoubleClick={() => winCommand("toggle")}
        title={frameless ? "Arraste para mover a janela; duplo clique maximiza" : undefined}
      />
      {alerts}
      {plan.shown.map(({ id, label }) => {
        const a = actById.get(id)!;
        return (
          <button
            key={id}
            className="flex h-6 w-8 shrink-0 items-center justify-center self-center rounded text-text-2 hover:bg-bg-hover hover:text-text-1"
            title={a.title}
            aria-label={a.label}
            onClick={a.onClick}
          >
            {a.icon}
            {label && <span className="whitespace-nowrap">{a.label}</span>}
          </button>
        );
      })}
      {plan.overflow.length > 0 && (
        <div className="relative shrink-0 self-center" data-no-drag>
          <button
            className="flex h-6 w-8 items-center justify-center rounded text-text-2 hover:bg-bg-hover hover:text-text-1"
            title="Mais ações"
            aria-label="Mais ações"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setMoreOpen((v) => !v)}
          >
            <MoreHorizontal size={15} />
          </button>
          {moreOpen && (
            <GlassMenu x={window.innerWidth - (frameless ? 340 : 200)} y={36} onClose={() => setMoreOpen(false)} className="min-w-[190px]">
              {plan.overflow.map((id) => {
                const a = actById.get(id)!;
                return (
                  <MenuItem
                    key={id}
                    icon={a.icon}
                    symbol={a.symbol}
                    label={a.label}
                    title={a.title}
                    onClick={() => {
                      setMoreOpen(false);
                      a.onClick();
                    }}
                  />
                );
              })}
            </GlassMenu>
          )}
        </div>
      )}
      <span className="mx-1 shrink-0 self-center" data-no-drag>
        {status}
      </span>
      <WindowControls state={win} />
      {menu && (
        <GlassMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} className="min-w-[190px]">
          <MenuItem icon={<Pencil size={14} />} symbol="pencil" label="Renomear…" onClick={() => { setEditing(menu.id); setMenu(null); }} />
          {layout.tabs.find((tt) => tt.id === menu.id)?.name && (
            <MenuItem
              icon={<Type size={14} />}
              symbol="type"
              label="Usar o nome do terminal"
              title="A aba passa a mostrar o nome do terminal (e acompanha quando ele muda)"
              onClick={() => { onRename(menu.id, ""); setMenu(null); }}
            />
          )}
          <MenuItem icon={<X size={14} />} symbol="x" label="Fechar aba" onClick={() => { onClose(menu.id); setMenu(null); }} />
          {(() => {
            const term = tabTerminal?.(menu.id);
            if (!term) return null;
            return (
              <>
                <MenuRule />
                <MenuItem
                  icon={<RotateCw size={14} />}
                  symbol="rotate-cw"
                  label="Reiniciar este terminal…"
                  disabled={!term.onRestart}
                  title={term.restartBlocked ?? "Abre um shell novo do mesmo tipo e na mesma pasta, no mesmo lugar, e encerra este (pede confirmação)"}
                  onClick={() => { setMenu(null); term.onRestart?.(); }}
                />
                <MenuItem
                  icon={<Power size={14} />}
                  symbol="power"
                  label="Matar terminal…"
                  danger
                  title="Encerra o terminal em foco e tudo o que ele abriu, e o tira da aba (pede confirmação)"
                  onClick={() => { setMenu(null); term.onKill(); }}
                />
              </>
            );
          })()}
          {onReopenClosed && (
            <>
              <MenuRule />
              <MenuItem
                icon={<RotateCcw size={14} />}
                symbol="rotate-ccw"
                label="Reabrir aba fechada"
                title="Volta a última aba fechada, com o nome e a divisão"
                onClick={() => { onReopenClosed(); setMenu(null); }}
              />
            </>
          )}
        </GlassMenu>
      )}
    </div>
  );
}

function RenameBox({ initial, onDone }: { initial: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      value={v}
      maxLength={60}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onDone(v)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(v);
        if (e.key === "Escape") onDone(null);
      }}
      className="w-32 rounded border border-accent bg-bg-term px-1 text-text-1 outline-none"
    />
  );
}
