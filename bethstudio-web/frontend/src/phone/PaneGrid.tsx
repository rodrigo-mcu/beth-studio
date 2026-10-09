import { useEffect, useMemo, useState } from "react";
import { FolderOpen } from "lucide-react";
import type { Connection } from "@/lib/connection";
import type { AgentState } from "@/lib/agents";
import type { PaneInfo } from "@/lib/types";
import type { Layout } from "@/lib/layout";
import { buildCards, previewLines, type GridCard } from "@/lib/termGrid";
import { kindText, waitedFor } from "./text";

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

interface Props {
  conn: Connection;
  /** já filtrados e na ordem da lista */
  panes: PaneInfo[];
  agents: AgentState;
  nameOf: (p: PaneInfo) => string;
  now: number;
  onOpen: (id: number) => void;
}

/** "Todos os terminais" em cartões: print da tela, nome, tipo, pasta e aba. */
export function PaneGrid({ conn, panes, agents, nameOf, now, onOpen }: Props) {
  const { layout, shots } = useGridData(conn, true);
  const where = useMemo(() => {
    const m = new Map<number, GridCard>();
    if (layout) for (const c of buildCards(panes, layout)) if (c.state !== "gone") m.set(c.pane, c);
    return m;
  }, [panes, layout]);
  return (
    <div className="p-grid">
      {panes.map((p) => {
        const a = agents[p.pane_id];
        const c = where.get(p.pane_id);
        const lines = previewLines(conn.lastScreenText(p.pane_id) ?? shots.get(p.pane_id), 6, 60);
        return (
          <button key={p.pane_id} type="button" className={a ? "p-card p-card--wait" : "p-card"} onClick={() => onOpen(p.pane_id)}>
            <span className="p-card__shot" aria-hidden="true">
              {lines.length ? lines.map((l, i) => <span key={i}>{l}</span>) : <em>sem texto</em>}
            </span>
            <span className="p-card__name">{nameOf(p)}</span>
            {c?.path && (
              <span className="p-card__meta">
                <FolderOpen size={12} aria-hidden="true" /> {c.path}
              </span>
            )}
            <span className="p-card__meta">
              {kindText(p.kind_label, p.agent)}
              {a ? ` · ${waitedFor(a.since, now)}` : ""}
            </span>
            {c && <span className="p-card__meta">{c.where}</span>}
          </button>
        );
      })}
    </div>
  );
}
