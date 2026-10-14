import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Columns2, FolderOpen, Loader2, Search, X } from "lucide-react";
import type { Connection } from "@/lib/connection";
import type { PaneInfo } from "@/lib/types";
import type { Layout } from "@/lib/layout";
import { buildCards, facetKindChips, facetStateCounts, filterCards, previewLines, toggleChip, type GridCard, type GridFilter, type GridKind } from "@/lib/termGrid";
import { AgentBadge, KindIcon } from "./KindIcon";
import { cn } from "@/lib/utils";

interface Props {
  conn: Connection;
  panes: PaneInfo[];
  layout: Layout;
  /** ordem dos grupos da barra lateral (Configurações). A grade não grava o filtro dela. */
  kindOrder?: string[] | null;
  onOpen: (c: GridCard) => void;
  onOpenBeside: (c: GridCard) => void;
  onClose: () => void;
}

const REFRESH_MS = 3000;

const FILTERS: { id: GridFilter; label: string; hint: string }[] = [
  { id: "all", label: "Todos", hint: "Todos os terminais" },
  { id: "tab", label: "Em abas", hint: "Terminais que estão numa aba aberta" },
  { id: "hidden", label: "Sem aba", hint: "Em abas fechadas ou fora de qualquer aba (continuam rodando)" },
  { id: "gone", label: "Encerrados", hint: "Terminais que terminaram e ainda aparecem numa aba" },
];

/** Popup com todos os terminais em grade: print da tela, nome, tipo, pasta e aba, com busca. */
const chipFocus = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export function TerminalGrid({ conn, panes, layout, kindOrder, onOpen, onOpenBeside, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<GridFilter>("all");
  const [kind, setKind] = useState<GridKind>("all");
  const [withScreen, setWithScreen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [shots, setShots] = useState<Map<number, string>>(new Map());
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  // Telas: um snapshot ao abrir e a cada 3 s enquanto o popup esta' aberto (o Go guarda 5 s de cache).
  useEffect(() => {
    let stop = false;
    const load = () => {
      setLoading(true);
      conn
        .api<{ panes: Record<string, string> }>("/api/content", { pane_ids: [] })
        .then((r) => {
          if (stop) return;
          const m = new Map<number, string>();
          for (const [k, v] of Object.entries(r.panes)) m.set(Number(k), v);
          setShots(m);
        })
        .catch(() => undefined)
        .finally(() => !stop && setLoading(false));
    };
    load();
    const iv = window.setInterval(load, REFRESH_MS);
    return () => {
      stop = true;
      window.clearInterval(iv);
    };
  }, [conn]);

  const cards = useMemo(() => buildCards(panes, layout), [panes, layout]);
  // a tela ao vivo de quem esta' sendo observado vale mais que o snapshot
  const screens = useMemo(() => {
    const m = new Map(shots);
    for (const c of cards) {
      const live = conn.lastScreenText(c.pane);
      if (live) m.set(c.pane, live);
    }
    return m;
  }, [shots, cards, conn]);
  // Cada fileira conta o que os outros filtros deixam: estado não zera ao ser clicado, tipo também não.
  const counts = useMemo(() => facetStateCounts(cards, kind, query, screens, withScreen), [cards, kind, query, screens, withScreen]);
  const kindChips = useMemo(() => facetKindChips(cards, filter, query, screens, withScreen, kindOrder, kind), [cards, filter, query, screens, withScreen, kindOrder, kind]);
  const shown = useMemo(() => filterCards(cards, filter, query, screens, withScreen, kind), [cards, filter, query, screens, withScreen, kind]);
  const clearFilters = () => {
    setQuery("");
    setFilter("all");
    setKind("all");
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/40 p-[4vh]" onMouseDown={onClose}>
      <div
        className="flex h-full w-[min(1180px,96vw)] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-card shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && shown[0] && (e.target as Element).tagName === "INPUT") onOpen(shown[0]);
        }}
      >
        <div className="flex flex-col gap-2 border-b border-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-[220px] flex-1 items-center gap-1.5 rounded border border-border bg-bg-term px-2 focus-within:border-accent">
              <Search size={14} className="shrink-0 text-text-3" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar por nome, pasta, tipo, aba ou #número…"
                className="h-9 min-w-0 flex-1 bg-transparent text-[14px] text-text-1 outline-none placeholder:text-text-3"
              />
              {loading && <Loader2 size={13} className="shrink-0 animate-spin text-text-3" />}
              {query && (
                <button type="button" className={cn("shrink-0 rounded text-text-3 hover:text-text-1", chipFocus)} title="Limpar busca" onClick={() => setQuery("")}>
                  <X size={14} />
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1" role="group" aria-label="Estado do terminal">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  title={f.hint}
                  aria-pressed={filter === f.id}
                  onClick={() => setFilter(toggleChip(filter, f.id, "all"))}
                  className={cn(
                    "min-h-11 rounded px-3 py-1 text-[12px]",
                    chipFocus,
                    filter === f.id ? "bg-accent-soft text-text-1 ring-1 ring-accent" : "text-text-2 hover:bg-bg-hover hover:text-text-1",
                  )}
                >
                  {f.label} <span className="text-text-3">{counts[f.id]}</span>
                </button>
              ))}
            </div>
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-text-2 hover:text-text-1" title="A busca também olha o texto que está na tela de cada terminal">
              <input type="checkbox" className="accent-[#2B6CB0]" checked={withScreen} onChange={(e) => setWithScreen(e.target.checked)} />
              Buscar também na tela
            </label>
            <button type="button" className={cn("rounded p-1 text-text-2 hover:bg-bg-hover hover:text-text-1", chipFocus)} title="Fechar (Esc)" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
          {cards.length > 0 && (
            <div className="flex flex-wrap gap-1" role="group" aria-label="Tipo de terminal">
              {kindChips.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  aria-pressed={kind === chip.id}
                  title={chip.id === "all" ? "Todos os tipos" : `Mostrar ${chip.label} (clique de novo para tirar)`}
                  onClick={() => setKind(toggleChip(kind, chip.id, "all"))}
                  className={cn(
                    "inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-[12px]",
                    chipFocus,
                    kind === chip.id ? "border border-transparent bg-accent text-white" : "border border-border bg-bg-panel text-text-2 hover:bg-bg-hover hover:text-text-1",
                  )}
                >
                  {chip.id === "agent" && <Bot size={13} aria-hidden="true" />}
                  {chip.label} <span className={cn("text-[11px]", kind === chip.id ? "text-white/80" : "text-text-3")}>{chip.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {shown.length === 0 ? (
            <div className="px-3 py-10 text-center text-text-2">
              {cards.length === 0 ? (
                "Nenhum terminal aberto."
              ) : (
                <>
                  <p>Nenhum terminal encontrado.</p>
                  <button type="button" className={cn("mt-3 min-h-11 rounded px-3 py-1.5 text-[13px] text-accent-text hover:bg-bg-hover", chipFocus)} onClick={clearFilters}>
                    Limpar filtros
                  </button>
                </>
              )}
            </div>
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
              {shown.map((c, i) => (
                <Card key={`${c.state}-${c.pane}-${i}`} c={c} lines={previewLines(screens.get(c.pane))} first={!!query.trim() && i === 0} onOpen={onOpen} onBeside={onOpenBeside} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Card({ c, lines, first, onOpen, onBeside }: { c: GridCard; lines: string[]; first: boolean; onOpen: (c: GridCard) => void; onBeside: (c: GridCard) => void }) {
  const gone = c.state === "gone";
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(c)}
        onKeyDown={(e) => e.key === "Enter" && onOpen(c)}
        title={
          gone
            ? "Terminal encerrado: leva até a aba dele"
            : c.state === "closed"
              ? "Reabre a aba fechada com este terminal"
              : c.state === "loose"
                ? "Abre numa aba nova"
                : "Vai até este terminal"
        }
        className={cn(
          "group flex cursor-pointer flex-col overflow-hidden rounded-md border border-border bg-bg-panel hover:border-accent",
          first && "border-accent ring-1 ring-accent",
          gone && "opacity-60",
        )}
      >
        <div className="h-[104px] overflow-hidden bg-bg-term px-2 py-1.5 font-mono text-[10px] leading-[13px] text-text-2">
          {lines.length ? (
            lines.map((l, i) => (
              <div key={i} className="truncate whitespace-pre">
                {l}
              </div>
            ))
          ) : (
            <div className="flex h-full items-center justify-center font-sans text-[11px] text-text-3">{gone ? "encerrado" : "sem texto na tela"}</div>
          )}
        </div>
        <div className="flex items-start gap-1.5 border-t border-border px-2 py-1.5">
          {c.info && <KindIcon pane={c.info} size={14} className="mt-0.5" />}
          <div className="min-w-0 flex-1">
            <div className={cn("flex items-center gap-1 text-[13px] text-text-1", gone && "line-through decoration-text-3")}>
              <span className="truncate">{c.title}</span>
              {c.info?.agent && <AgentBadge />}
              <span className="ml-auto shrink-0 text-[10px] text-text-3">#{c.pane}</span>
            </div>
            {c.path && (
              <div className="flex items-center gap-1 truncate text-[11px] text-text-2" title={c.path}>
                <FolderOpen size={11} className="shrink-0 text-text-3" />
                <span className="truncate">{c.path}</span>
              </div>
            )}
            <div className="truncate text-[11px] text-text-3">
              {c.kindLabel && <>{c.kindLabel} · </>}
              {c.where}
            </div>
          </div>
          {!gone && (
            <button
              className="shrink-0 rounded p-1 text-text-3 opacity-0 hover:bg-bg-card hover:text-text-1 group-hover:opacity-100"
              title="Abrir ao lado do terminal em foco"
              onClick={(e) => {
                e.stopPropagation();
                onBeside(c);
              }}
            >
              <Columns2 size={14} />
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
