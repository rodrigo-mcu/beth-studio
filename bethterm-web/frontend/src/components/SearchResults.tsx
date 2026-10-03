import { useEffect, useRef, type ReactNode } from "react";
import { Columns2, FolderInput, Loader2, Search, X } from "lucide-react";
import type { PaneInfo } from "@/lib/types";
import { snippet, type SearchResult } from "@/lib/search";
import { hostPlace, type SearchState } from "@/lib/useSearch";
import { cn } from "@/lib/utils";

export interface ResultActions {
  go: (r: SearchResult) => void;
  openBeside: (pane: number) => void;
  moveMenu: (pane: number, x: number, y: number) => void;
}

/** Campo de busca + opcao de procurar no conteudo das telas. */
export function SearchInput({ s, autoFocus, compact }: { s: SearchState; autoFocus?: boolean; compact?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 rounded border border-border bg-bg-term px-2 focus-within:border-accent">
        <Search size={14} className="shrink-0 text-text-3" />
        <input
          ref={ref}
          value={s.query}
          onChange={(e) => s.setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && s.setQuery("")}
          placeholder="Buscar terminal…"
          className={cn("min-w-0 flex-1 bg-transparent text-text-1 outline-none placeholder:text-text-3", compact ? "h-7" : "h-9 text-[14px]")}
        />
        {s.loadingContent && <Loader2 size={13} className="shrink-0 animate-spin text-text-3" />}
        {s.query && (
          <button className="shrink-0 text-text-3 hover:text-text-1" title="Limpar busca" onClick={() => s.setQuery("")}>
            <X size={14} />
          </button>
        )}
      </div>
      <label
        className="flex cursor-pointer select-none items-center gap-1.5 px-0.5 text-[11px] text-text-2 hover:text-text-1"
        title="Lê o texto visível da tela de cada terminal (sob demanda, a cada 3 s enquanto a busca está aberta)"
      >
        <input type="checkbox" className="accent-[#2B6CB0]" checked={s.withContent} onChange={(e) => s.setWithContent(e.target.checked)} />
        Procurar também no conteúdo da tela
        {s.contentInfo && <span className="ml-auto truncate text-text-3">{s.contentInfo}</span>}
      </label>
    </div>
  );
}

function Highlight({ text, ranges }: { text: string; ranges: [number, number][] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) parts.push(text.slice(at, a));
    parts.push(
      <mark key={i} className="rounded-sm bg-amber-300/30 px-px text-inherit">
        {text.slice(a, b)}
      </mark>,
    );
    at = b;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

interface Props {
  s: SearchState;
  panes: PaneInfo[];
  where: (pane: number, gone: boolean, tabFromEntry?: string) => string;
  actions: ResultActions;
  /** resultado com foco (palheta, setas do teclado) */
  selected?: number;
}

export function SearchResults({ s, panes, where, actions, selected }: Props) {
  if (!s.query.trim()) return null;
  if (s.results.length === 0) {
    return <div className="px-3 py-4 text-center text-text-2">Nenhum terminal encontrado.</div>;
  }
  const byId = new Map(panes.map((p) => [p.pane_id, p]));
  return (
    <ul className="flex flex-col gap-0.5">
      {s.results.map((r, i) => {
        const title = r.hits.find((h) => h.field.kind === "title");
        const titleText = r.entry.fields[0].text;
        const other = r.hits.find((h) => h.field.kind !== "title");
        const info = byId.get(r.entry.pane);
        const webTab = r.entry.fields.find((f) => f.kind === "webtab")?.text;
        const sn = other ? snippet(other.field.text, other.ranges, other.field.kind === "content" ? 36 : 60) : null;
        return (
          <li key={`${r.entry.gone ? "g" : "p"}${r.entry.pane}-${i}`}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => actions.go(r)}
              className={cn(
                "group flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-bg-hover",
                selected === i && "bg-bg-hover ring-1 ring-accent",
                r.entry.gone && "opacity-55",
              )}
              title={
                r.entry.gone
                  ? "Terminal encerrado — clique para ir até a aba dele"
                  : "Clique para ir até este terminal (se não estiver numa aba, abre numa aba nova)"
              }
            >
              <div className="min-w-0 flex-1">
                <div className={cn("truncate text-[13px] text-text-1", r.entry.gone && "line-through decoration-text-3")}>
                  <Highlight text={titleText} ranges={title?.ranges ?? []} />
                </div>
                <div className="truncate text-[11px] text-text-3">
                  {r.entry.gone ? (
                    <>terminal encerrado · aba “{webTab}”</>
                  ) : (
                    <>
                      {where(r.entry.pane, false)}
                      {info && <> · BethTerm: {hostPlace(info)}</>}
                    </>
                  )}
                </div>
                {sn && (
                  <div className="mt-0.5 truncate font-mono text-[11px] text-text-2">
                    <span className="mr-1 rounded bg-bg-card px-1 font-sans text-[10px] text-text-3">{other!.field.label}</span>
                    <Highlight text={sn.text} ranges={sn.ranges} />
                  </div>
                )}
              </div>
              {!r.entry.gone && (
                <div className="flex shrink-0 gap-0.5 opacity-50 group-hover:opacity-100">
                  <button
                    className="rounded p-1 text-text-2 hover:bg-bg-card hover:text-text-1"
                    title="Abrir ao lado do terminal em foco"
                    onClick={(e) => {
                      e.stopPropagation();
                      actions.openBeside(r.entry.pane);
                    }}
                  >
                    <Columns2 size={14} />
                  </button>
                  <button
                    className="rounded p-1 text-text-2 hover:bg-bg-card hover:text-text-1"
                    title="Mover para aba…"
                    onClick={(e) => {
                      e.stopPropagation();
                      actions.moveMenu(r.entry.pane, e.clientX, e.clientY);
                    }}
                  >
                    <FolderInput size={14} />
                  </button>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
