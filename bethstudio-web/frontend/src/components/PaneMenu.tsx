import { useEffect, useState, type ReactNode } from "react";
import { AppWindow, ArrowLeft, ChevronRight, Columns2, FolderInput, LogOut, Plus, Power, Rows2, SplitSquareHorizontal, SquarePlus } from "lucide-react";
import type { PaneInfo } from "@/lib/types";
import { findPane, type Layout, type WebTab, type Zone } from "@/lib/layout";
import { SPLIT_ZONES, ZONE_LABEL, type SplitZone } from "@/lib/splitSpawn";
import { ZONE_ICON } from "./SplitShellMenu";
import { paneLabel, shortCwd } from "@/lib/panes";

export interface PaneMenuActions {
  moveToTab: (pane: number, tabId: string) => void;
  moveToNewTab: (pane: number) => void;
  /** divide `target` colocando `other` na zona indicada */
  splitWith: (target: number, other: number, zone: Exclude<Zone, "center">) => void;
  unorganize: (pane: number) => void;
  /** "Destacar em janela": janela nativa do Windows (ausente = remoto/somente leitura) */
  detach?: (pane: number) => void;
  /** abre a confirmacao "Encerrar este terminal?" (nao encerra direto) */
  askKill?: (pane: number) => void;
  /** abre "Separar no Beth Studio?" (so' para panes em split no host) */
  askSeparate?: (pane: number) => void;
  /** o pane divide a aba do host com outros? */
  inHostSplit?: (pane: number) => boolean;
  /** "Novo terminal à direita/…": abre a escolha do shell (ausente = somente leitura) */
  newSplit?: (pane: number, zone: SplitZone, x: number, y: number) => void;
}

interface Props {
  pane: number;
  x: number;
  y: number;
  layout: Layout;
  panes: PaneInfo[];
  actions: PaneMenuActions;
  onClose: () => void;
  initialView?: "root" | "tabs";
  /** nome exibido da aba do web */
  tabTitle?: (t: WebTab) => string;
}

type View = "root" | "tabs" | "right" | "bottom";

/** Menu "Organizar" de um terminal (tudo por clique). */
export function PaneMenu({ pane, x, y, layout, panes, actions, onClose, initialView, tabTitle }: Props) {
  const [view, setView] = useState<View>(initialView ?? "root");
  const at = findPane(layout, pane);
  const title = (t: WebTab) => (tabTitle ? tabTitle(t) : t.name);
  const tabName = (id: string) => {
    const t = layout.tabs.find((tt) => tt.id === id);
    return t ? title(t) : "";
  };

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [onClose]);

  const done = (f: () => void) => () => {
    f();
    onClose();
  };
  const others = panes.filter((p) => p.pane_id !== pane);

  return (
    <div
      className="fixed z-50 max-h-[70vh] w-[300px] overflow-y-auto rounded-md border border-border-strong bg-bg-card py-1 shadow-xl"
      style={{
        left: Math.min(x, window.innerWidth - 310),
        top: Math.min(y, window.innerHeight - 300),
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {view === "root" && (
        <>
          {actions.newSplit && at && (
            <>
              {SPLIT_ZONES.map((z) => (
                <Item key={z} icon={ZONE_ICON[z]} label={ZONE_LABEL[z]} arrow onClick={done(() => actions.newSplit!(pane, z, x, y))} />
              ))}
              <div className="my-1 border-t border-border" />
            </>
          )}
          <Item icon={<FolderInput size={14} />} label="Mover para aba…" arrow onClick={() => setView("tabs")} />
          <Item icon={<SquarePlus size={14} />} label="Abrir numa aba nova" onClick={done(() => actions.moveToNewTab(pane))} />
          {actions.detach && (
            <Item
              icon={<AppWindow size={14} />}
              label="Destacar em janela"
              hint="janela separada; o terminal continua rodando"
              onClick={done(() => actions.detach!(pane))}
            />
          )}
          <Item icon={<Columns2 size={14} />} label="Dividir ao lado com…" arrow onClick={() => setView("right")} />
          <Item icon={<Rows2 size={14} />} label="Dividir abaixo com…" arrow onClick={() => setView("bottom")} />
          {at && (
            <>
              <div className="my-1 border-t border-border" />
              <Item
                icon={<LogOut size={14} />}
                label={`Tirar de "${tabName(at.tabId)}"`}
                hint="continua rodando, em Não organizados"
                onClick={done(() => actions.unorganize(pane))}
              />
            </>
          )}
          {actions.askSeparate && actions.inHostSplit?.(pane) && (
            <Item
              icon={<SplitSquareHorizontal size={14} />}
              label="Separar no Beth Studio para ajustar à janela…"
              hint="sai do split na GUI; nada é encerrado"
              onClick={done(() => actions.askSeparate!(pane))}
            />
          )}
          {actions.askKill && (
            <>
              <div className="my-1 border-t border-border" />
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-status-err hover:bg-status-err/10"
                onClick={done(() => actions.askKill!(pane))}
                title="Encerra o processo no Beth Studio (pede confirmação)"
              >
                <span className="w-4 shrink-0">
                  <Power size={14} />
                </span>
                Encerrar terminal…
              </button>
            </>
          )}
        </>
      )}
      {view === "tabs" && (
        <>
          <Back onClick={() => setView("root")} label="Mover para aba" />
          {layout.tabs.map((t) => (
            <Item
              key={t.id}
              label={title(t)}
              hint={at?.tabId === t.id ? "está aqui" : undefined}
              disabled={at?.tabId === t.id}
              onClick={done(() => actions.moveToTab(pane, t.id))}
            />
          ))}
          <div className="my-1 border-t border-border" />
          <Item icon={<Plus size={14} />} label="Nova aba" onClick={done(() => actions.moveToNewTab(pane))} />
        </>
      )}
      {(view === "right" || view === "bottom") && (
        <>
          <Back onClick={() => setView("root")} label={view === "right" ? "Dividir ao lado com" : "Dividir abaixo com"} />
          {others.length === 0 && <div className="px-3 py-1.5 text-text-3">Nenhum outro terminal.</div>}
          {others.map((p) => {
            const where = findPane(layout, p.pane_id);
            return (
              <Item
                key={p.pane_id}
                label={paneLabel(p)}
                hint={`${shortCwd(p.cwd)}${where ? ` · em "${tabName(where.tabId)}"` : " · não organizado"}`}
                onClick={done(() => actions.splitWith(pane, p.pane_id, view))}
              />
            );
          })}
        </>
      )}
    </div>
  );
}

function Item(p: { icon?: ReactNode; label: string; hint?: string; arrow?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-text-1 hover:bg-bg-hover disabled:cursor-default disabled:text-text-3 disabled:hover:bg-transparent"
      disabled={p.disabled}
      onClick={p.onClick}
    >
      <span className="w-4 shrink-0">{p.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{p.label}</span>
        {p.hint && <span className="block truncate text-[11px] text-text-3">{p.hint}</span>}
      </span>
      {p.arrow && <ChevronRight size={14} className="text-text-3" />}
    </button>
  );
}

function Back({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      className="flex w-full items-center gap-2 border-b border-border px-3 py-1.5 text-left font-semibold text-text-2 hover:bg-bg-hover"
      onClick={onClick}
    >
      <ArrowLeft size={14} /> {label}
    </button>
  );
}
