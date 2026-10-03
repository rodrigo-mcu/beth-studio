import { useEffect, useLayoutEffect, useRef, useState, type DragEvent as RDragEvent, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  RotateCcw,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Type,
  X,
} from "lucide-react";
import { isFrameless, startDrag, useWindowState, winCommand } from "@/lib/windowFrame";
import { ICON_W, labelWidth, planBarActions } from "@/lib/tabBarLayout";
import { WindowControls } from "./WindowControls";
import { buildStudioActions, type StudioAction } from "./StudioActions";
import type { Layout, WebTab } from "@/lib/layout";
import { countLeaves } from "@/lib/layout";
import { PANE_MIME, TAB_MIME, draggedPane, endDrag, startTabDrag, useDrag } from "@/lib/dnd";
import { cn } from "@/lib/utils";

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
  /** abre a paleta "ir para terminal" */
  onSearch: () => void;
  /** Gerenciador de tarefas (memoria, CPU, GPU, disco, terminais, WSL) */
  onTaskManager?: () => void;
  /** painel Banco de dados */
  onDatabase?: () => void;
  /** tela SSH e Serial (hosts salvos, arquivos, portas COM) */
  onTools?: () => void;
  /** "Abrir arquivo…": texto/Markdown no painel de ver e editar */
  onOpenFile?: () => void;
  /** "Novo arquivo": cria um .md/.txt numa pasta escolhida e abre para editar */
  onNewFile?: () => void;
  /** abre "Aparencia geral" */
  onGeneral: () => void;
  /** abas do web com algum agente aguardando */
  waitingTabs: Set<string>;
  /** "+ Nova aba" abre o popup "Novo terminal" (null = so' cria aba vazia) */
  onNewTab?: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  /** nome exibido (o do usuario ou o do terminal) */
  tabTitle: (t: WebTab, index: number) => string;
  /** LED da conexao (fica a' direita) */
  status?: ReactNode;
  /** microfone para o terminal em foco (ausente = sem botao) */
  onSpeak?: () => void;
  /** os botoes de ferramenta estao na barra lateral (nao repetir aqui) */
  hideActions?: boolean;
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
  onSearch,
  onTaskManager,
  onDatabase,
  onTools,
  onOpenFile,
  onNewFile,
  onGeneral,
  waitingTabs,
  onNewTab,
  sidebarCollapsed,
  onToggleSidebar,
  tabTitle,
  status,
  onSpeak,
  hideActions,
}: Props) {
  const drag = useDrag();
  const [editing, setEditing] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const win = useWindowState();
  const frameless = isFrameless();
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

  const acts: StudioAction[] = hideActions ? [] : buildStudioActions({ onSearch, onGeneral, onTaskManager, onDatabase, onTools, onOpenFile, onNewFile, onSpeak });
  // o que fica fixo: icone, recolher, minimo das abas, "Nova aba", area de arraste, LED, botoes da janela
  const newTabLabel = false; // acoes sempre so' icone (produto para devs)
  const reserved = (frameless ? 30 + 138 : 0) + 32 + 170 + (newTabLabel ? labelWidth("Nova aba") : ICON_W) + 56 + 20 + 16;
  const plan = planBarActions(barW - reserved, acts);
  const actById = new Map(acts.map((a) => [a.id, a]));

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  const accepts = (e: RDragEvent) => e.dataTransfer.types.includes(PANE_MIME) || e.dataTransfer.types.includes(TAB_MIME);

  return (
    <div
      ref={barRef}
      data-term-drop="tabs"
      className={cn(
        "flex h-7 shrink-0 items-end gap-0.5 overflow-hidden border-b border-border px-2 pt-1 select-none",
        frameless && !win.active && "opacity-75",
      )}
      onMouseDown={startDrag}
      onDoubleClick={(e) => {
        if (!frameless || (e.target as Element).closest("button,input,[draggable=true],[data-no-drag]")) return;
        winCommand("toggle");
      }}
    >
      <button
        className="mb-0.5 mr-1 flex h-5 w-7 shrink-0 items-center justify-center rounded text-text-2 hover:bg-bg-hover hover:text-text-1"
        title={sidebarCollapsed ? "Mostrar a barra lateral" : "Recolher a barra lateral"}
        onClick={onToggleSidebar}
      >
        {sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
      </button>
      {scrollL && (
        <button
          className="mb-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-2 hover:bg-bg-hover"
          title="Abas à esquerda"
          onClick={() => tabsRef.current?.scrollBy({ left: -240, behavior: "smooth" })}
        >
          <ChevronLeft size={14} />
        </button>
      )}
      <div
        ref={tabsRef}
        onScroll={checkScroll}
        className="flex min-w-[120px] shrink items-end gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {layout.tabs.map((t, i) => {
          const active = t.id === layout.active;
          const n = countLeaves(t.root);
          return (
            <div
              key={t.id}
              draggable={editing !== t.id}
              onDragStart={(e) => startTabDrag(e, t.id)}
              onDragEnd={endDrag}
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
              className={cn(
                "group flex h-6 min-w-[96px] max-w-[220px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-3 text-[12.5px]",
                active ? "border-border bg-bg-panel text-text-1" : "border-transparent text-text-2 hover:bg-bg-hover hover:text-text-1",
                over === t.id && "border-accent bg-accent-soft text-text-1",
                drag?.kind === "pane" && !active && "border-dashed border-border-strong",
              )}
              title={`${tabTitle(t, i)}${t.name ? "" : " (nome do terminal)"} — ${n} terminal(is)\nClique para abrir, duplo clique para renomear, arraste para reordenar`}
            >
              {editing === t.id ? (
                <RenameBox
                  initial={t.name || tabTitle(t, i)}
                  onDone={(v) => {
                    setEditing(null);
                    if (v === null) return;
                    // sem mudar nada numa aba sem nome: continua acompanhando o terminal
                    if (!t.name && v.trim() === tabTitle(t, i)) return;
                    onRename(t.id, v);
                  }}
                />
              ) : (
                <span className={cn("truncate", !t.name && "italic")}>{tabTitle(t, i)}</span>
              )}
              {waitingTabs.has(t.id) && (
                <span className="relative inline-flex h-2 w-2 shrink-0" title="Um agente nesta aba aguarda sua resposta">
                  <span className="absolute inset-0 animate-ping rounded-full bg-status-warn opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-status-warn" />
                </span>
              )}
              <span className="shrink-0 rounded bg-bg-hover px-1 text-[10px] text-text-3">{n}</span>
              <button
                className={cn("shrink-0 rounded p-0.5 hover:bg-bg-card", active ? "text-text-2" : "text-transparent group-hover:text-text-2")}
                title={n > 0 ? "Fechar aba — os terminais continuam rodando em Não organizados" : "Fechar aba"}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      {scrollR && (
        <button
          className="mb-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-2 hover:bg-bg-hover"
          title="Abas à direita"
          onClick={() => tabsRef.current?.scrollBy({ left: 240, behavior: "smooth" })}
        >
          <ChevronRight size={14} />
        </button>
      )}
      <button
        className={cn(
          "ml-0.5 flex h-6 w-8 shrink-0 items-center justify-center self-center rounded text-text-2 hover:bg-bg-hover hover:text-text-1",
          over === "+" && "bg-accent-soft text-text-1 ring-1 ring-accent",
        )}
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
        <Plus size={16} />
        {newTabLabel && "Nova aba"}
      </button>
      <div
        className="h-full min-w-[48px] flex-1"
        onMouseDown={startDrag}
        onDoubleClick={() => winCommand("toggle")}
        title={frameless ? "Arraste para mover a janela; duplo clique maximiza" : undefined}
      />
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
            <div
              className="fixed z-50 mt-1 min-w-[190px] rounded-md border border-border-strong bg-bg-card py-1 shadow-xl"
              style={{ right: frameless ? 150 : 8 }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {plan.overflow.map((id) => {
                const a = actById.get(id)!;
                return (
                  <button
                    key={id}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-text-1 hover:bg-bg-hover"
                    title={a.title}
                    onClick={() => {
                      setMoreOpen(false);
                      a.onClick();
                    }}
                  >
                    {a.icon} {a.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      <span className="mx-1 shrink-0 self-center" data-no-drag>
        {status}
      </span>
      <WindowControls state={win} />
      {menu && (
        <div
          className="fixed z-50 min-w-[170px] rounded-md border border-border-strong bg-bg-card py-1 shadow-xl"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-text-1 hover:bg-bg-hover"
            onClick={() => {
              setEditing(menu.id);
              setMenu(null);
            }}
          >
            <Pencil size={14} /> Renomear…
          </button>
          {layout.tabs.find((tt) => tt.id === menu.id)?.name && (
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-text-1 hover:bg-bg-hover"
              onClick={() => {
                onRename(menu.id, "");
                setMenu(null);
              }}
              title="A aba passa a mostrar o nome do terminal (e acompanha quando ele muda)"
            >
              <Type size={14} /> Usar o nome do terminal
            </button>
          )}
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-text-1 hover:bg-bg-hover"
            onClick={() => {
              onClose(menu.id);
              setMenu(null);
            }}
          >
            <X size={14} /> Fechar aba
          </button>
          {onReopenClosed && (
            <button
              className="flex w-full items-center gap-2 border-t border-border px-3 py-1.5 text-left text-text-1 hover:bg-bg-hover"
              onClick={() => {
                onReopenClosed();
                setMenu(null);
              }}
              title="Volta a última aba fechada, com o nome e a divisão"
            >
              <RotateCcw size={14} /> Reabrir aba fechada
            </button>
          )}
        </div>
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
