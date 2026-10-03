import { useEffect, useMemo, useRef, useState } from "react";
import type { Connection } from "./connection";
import type { PaneInfo } from "./types";
import { findPane, leaves, tabDisplayName, type Layout } from "./layout";
import { lastFolder, search, stripAnsi, type SearchEntry, type SearchResult } from "./search";
import { paneLabel, shortCwd } from "./panes";

export interface SearchState {
  query: string;
  setQuery: (q: string) => void;
  withContent: boolean;
  setWithContent: (v: boolean) => void;
  results: SearchResult[];
  loadingContent: boolean;
  contentInfo: string | null;
}

/** Onde o terminal esta' no Beth Studio (janela/aba do host). */
export function hostPlace(p: PaneInfo): string {
  const w = p.window_title?.trim() || `Janela ${p.window_id}`;
  const t = p.tab_title?.trim();
  return t ? `${w} › ${t}` : w;
}

export function buildEntries(panes: PaneInfo[], layout: Layout | null, content: Map<number, string>): SearchEntry[] {
  const tabName = (pane: number) => {
    if (!layout) return "";
    const at = findPane(layout, pane);
    if (!at) return "Não organizados";
    const i = layout.tabs.findIndex((t) => t.id === at.tabId);
    return i >= 0 ? tabDisplayName(layout.tabs[i], i, (p) => panes.find((x) => x.pane_id === p)?.title) : "";
  };
  const out: SearchEntry[] = panes.map((p) => {
    const path = shortCwd(p.cwd, 99);
    const fields: SearchEntry["fields"] = [
      { kind: "title", label: "Título", text: paneLabel(p) },
      { kind: "folder", label: "Pasta", text: lastFolder(path) },
      { kind: "cwd", label: "Caminho", text: path },
      { kind: "webtab", label: "Aba", text: tabName(p.pane_id) },
      { kind: "host", label: "Beth Studio", text: hostPlace(p) },
      { kind: "id", label: "Id", text: `pane ${p.pane_id} #${p.pane_id}` },
    ];
    const c = content.get(p.pane_id);
    if (c) fields.push({ kind: "content", label: "Tela", text: c });
    return { pane: p.pane_id, gone: false, fields };
  });
  // Terminais encerrados que ainda estao na organizacao do web.
  if (layout) {
    for (const t of layout.tabs) {
      for (const { leaf } of leaves(t.root)) {
        if (!leaf.gone) continue;
        const path = shortCwd(leaf.cwd ?? "", 99);
        out.push({
          pane: leaf.pane,
          gone: true,
          fields: [
            { kind: "title", label: "Título", text: leaf.title || `Terminal ${leaf.pane}` },
            { kind: "folder", label: "Pasta", text: lastFolder(path) },
            { kind: "cwd", label: "Caminho", text: path },
            { kind: "webtab", label: "Aba", text: t.name || leaf.title || "" },
          ],
        });
      }
    }
  }
  return out;
}

const CONTENT_REFRESH_MS = 3000;

/**
 * Busca ao vivo (debounce 150 ms). Com `withContent`, o texto das telas vem
 * dos panes observados (ja' na pagina) e, para os outros, de POST
 * /api/content (snapshot sob demanda no Go, cache de 5 s; no maximo 1
 * pedido a cada 3 s enquanto a busca esta' aberta).
 */
export function useSearch(conn: Connection, panes: PaneInfo[] | null, layout: Layout | null, active: boolean): SearchState {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [withContent, setWithContent] = useState(false);
  const [content, setContent] = useState<Map<number, string>>(new Map());
  const [loadingContent, setLoading] = useState(false);
  const [contentInfo, setInfo] = useState<string | null>(null);
  const lastFetch = useRef(0);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query), 150);
    return () => window.clearTimeout(t);
  }, [query]);

  // Conteudo das telas (sob demanda).
  useEffect(() => {
    if (!active || !withContent || !debounced.trim()) return;
    let stop = false;
    const fetchNow = () => {
      if (Date.now() - lastFetch.current < CONTENT_REFRESH_MS) return;
      lastFetch.current = Date.now();
      setLoading(true);
      conn
        .api<{ panes: Record<string, string>; missing: number[]; ms: number }>("/api/content", { pane_ids: [] })
        .then((r) => {
          if (stop) return;
          const m = new Map<number, string>();
          for (const [k, v] of Object.entries(r.panes)) m.set(Number(k), v);
          setContent(m);
          setInfo(`${m.size} telas lidas em ${r.ms} ms${r.missing.length ? ` (${r.missing.length} sem resposta)` : ""}`);
        })
        .catch((e: Error) => !stop && setInfo(`Conteúdo indisponível: ${e.message}`))
        .finally(() => !stop && setLoading(false));
    };
    fetchNow();
    const iv = window.setInterval(fetchNow, CONTENT_REFRESH_MS);
    return () => {
      stop = true;
      window.clearInterval(iv);
    };
  }, [conn, active, withContent, debounced]);

  const results = useMemo(() => {
    if (!panes || !debounced.trim()) return [];
    let c = content;
    if (withContent) {
      // telas ao vivo dos panes observados valem mais que o snapshot
      c = new Map(content);
      for (const p of panes) {
        const raw = conn.lastScreenText(p.pane_id);
        if (raw) c.set(p.pane_id, stripAnsi(raw));
      }
    } else c = new Map();
    return search(buildEntries(panes, layout, c), debounced);
  }, [conn, panes, layout, content, withContent, debounced]);

  return { query, setQuery, withContent, setWithContent, results, loadingContent, contentInfo: withContent ? contentInfo : null };
}
