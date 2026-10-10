import { useEffect, useMemo, useState } from "react";
import { FolderOpen, Search, X } from "lucide-react";
import type { Connection } from "@/lib/connection";
import type { AgentState } from "@/lib/agents";
import type { PaneInfo } from "@/lib/types";
import type { Layout } from "@/lib/layout";
import { buildCards, countByFilter, filterCards, previewLines, type GridCard, type GridFilter } from "@/lib/termGrid";
import { shortCwd } from "@/lib/panes";
import { waitedFor } from "./text";

const REFRESH_MS = 4000;

/** Layout das abas do Studio e o texto das telas; pedidos só enquanto a grade está na tela. */
export function useGridData(conn: Connection, active: boolean): { layout: Layout | null; shots: Map<number, string> } {
  const [layout, setLayout] = useState<Layout | null>(null);
  const [shots, setShots] = useState<Map<number, string>>(new Map());
  useEffect(() => {
    if (!active) return;
    let stop = false;
    // PC com um Studio mais antigo não tem estes pedidos: a grade segue sem print/aba.
    const load = () => {
      if (document.visibilityState !== "visible") return;
      void conn
        .api<{ panes: Record<string, string> }>("/api/phone/content", { pane_ids: [] })
        .then((r) => {
          if (stop) return;
          const m = new Map<number, string>();
          for (const [k, v] of Object.entries(r.panes ?? {})) m.set(Number(k), v);
          setShots(m);
        })
        .catch(() => undefined);
    };
    void conn
      .api<Layout>("/api/phone/layout")
      .then((l) => !stop && l && Array.isArray(l.tabs) && setLayout(l))
      .catch(() => undefined);
    load();
    const iv = window.setInterval(load, REFRESH_MS);
    return () => {
      stop = true;
      window.clearInterval(iv);
    };
  }, [conn, active]);
  return { layout, shots };
}

// Busca e filtro da grade sobrevivem a abrir um terminal e voltar.
let keptQuery = "";
let keptFilter: GridFilter = "all";
let keptScreen = false;

const FILTERS: { id: GridFilter; label: string }[] = [
  { id: "all", label: "Todos" },
  { id: "tab", label: "Em abas" },
  { id: "hidden", label: "Sem aba" },
  { id: "gone", label: "Encerrados" },
];

interface Props {
  conn: Connection;
  /** todos os terminais vivos, sem filtro: a grade tem a própria busca */
  panes: PaneInfo[];
  agents: AgentState;
  nameOf: (p: PaneInfo) => string;
  now: number;
  onOpen: (id: number) => void;
}

/** "Todos os terminais" como no desktop: cartões com print, nome, pasta, tipo e aba, com busca e filtros. */
export function PaneGrid({ conn, panes, agents, nameOf, now, onOpen }: Props) {
  const { layout, shots } = useGridData(conn, true);
  const [query, setQueryState] = useState(keptQuery);
  const [filter, setFilterState] = useState<GridFilter>(keptFilter);
  const [withScreen, setWithScreenState] = useState(keptScreen);
  const setQuery = (v: string) => {
    keptQuery = v;
    setQueryState(v);
  };
  const setFilter = (v: GridFilter) => {
    keptFilter = v;
    setFilterState(v);
  };
  const setWithScreen = (v: boolean) => {
    keptScreen = v;
    setWithScreenState(v);
  };

  const cards = useMemo(() => {
    // PC com Studio antigo não manda o layout: todos entram como "em aba", sem nome de aba.
    const base: GridCard[] = layout
      ? buildCards(panes, layout)
      : panes.map((p) => ({ pane: p.pane_id, state: "tab" as const, title: p.title, path: shortCwd(p.cwd, 99), kindLabel: p.kind_label || "", where: "", info: p }));
    const named = base.map((c) => (c.info ? { ...c, title: nameOf(c.info) } : c));
    // quem espera você vem primeiro; fora isso, a ordem do desktop
    return [...named.filter((c) => agents[c.pane]), ...named.filter((c) => !agents[c.pane])];
  }, [panes, layout, agents, nameOf]);
  const counts = useMemo(() => countByFilter(cards), [cards]);
  const screens = useMemo(() => {
    const m = new Map(shots);
    for (const c of cards) {
      const live = conn.lastScreenText(c.pane);
      if (live) m.set(c.pane, live);
    }
    return m;
  }, [shots, cards, conn]);
  const shown = useMemo(() => filterCards(cards, filter, query, screens, withScreen), [cards, filter, query, screens, withScreen]);
  const filters = layout ? FILTERS : FILTERS.slice(0, 1);

  return (
    <>
      <div className="p-find">
        <label className="p-search">
          <Search size={18} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder="Nome, pasta, tipo, aba ou #número"
            aria-label="Procurar terminal"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button type="button" aria-label="Limpar a busca" onClick={() => setQuery("")}>
              <X size={18} />
            </button>
          )}
        </label>
        {filters.length > 1 && (
          <div className="p-chips" role="group" aria-label="Quais terminais">
            {filters.map((f) => (
              <button key={f.id} type="button" className="p-chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label} {counts[f.id]}
              </button>
            ))}
          </div>
        )}
        <label className="p-check">
          <input type="checkbox" checked={withScreen} onChange={(e) => setWithScreen(e.target.checked)} />
          Buscar também na tela
        </label>
      </div>
      {shown.length === 0 ? (
        <div className="p-empty">
          <strong>{cards.length === 0 ? "Nenhum terminal aberto" : "Nenhum terminal encontrado"}</strong>
          {cards.length > 0 && (
            <button
              type="button"
              className="p-link"
              onClick={() => {
                setQuery("");
                setFilter("all");
              }}
            >
              Mostrar todos
            </button>
          )}
        </div>
      ) : (
        <div className="p-grid">
          {shown.map((c, i) => {
            const a = agents[c.pane];
            const gone = c.state === "gone";
            const lines = previewLines(screens.get(c.pane), 6, 60);
            return (
              <button
                key={`${c.state}-${c.pane}-${i}`}
                type="button"
                disabled={gone}
                className={"p-card" + (a ? " p-card--wait" : "") + (gone ? " p-card--gone" : "")}
                onClick={() => onOpen(c.pane)}
              >
                <span className="p-card__shot" aria-hidden="true">
                  {lines.length ? lines.map((l, j) => <span key={j}>{l}</span>) : <em>{gone ? "encerrado" : "sem texto"}</em>}
                </span>
                <span className="p-card__name">
                  {c.title}
                  <small>#{c.pane}</small>
                </span>
                {c.path && (
                  <span className="p-card__meta">
                    <FolderOpen size={12} aria-hidden="true" /> {c.path}
                  </span>
                )}
                <span className="p-card__meta">{[c.kindLabel, a ? waitedFor(a.since, now) : ""].filter(Boolean).join(" · ")}</span>
                {c.where && <span className="p-card__meta">{c.where}</span>}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
