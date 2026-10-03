import { useState } from "react";
import { X } from "lucide-react";
import type { PaneInfo } from "@/lib/types";
import type { SearchState } from "@/lib/useSearch";
import { SearchInput, SearchResults, type ResultActions } from "./SearchResults";

interface Props {
  s: SearchState;
  panes: PaneInfo[];
  where: (pane: number, gone: boolean) => string;
  actions: ResultActions;
  onClose: () => void;
}

/** Paleta flutuante "ir para terminal". */
export function SearchPalette({ s, panes, where, actions, onClose }: Props) {
  const [sel, setSel] = useState(0);
  const go: ResultActions = {
    ...actions,
    go: (r) => {
      actions.go(r);
      onClose();
    },
    openBeside: (p) => {
      actions.openBeside(p);
      onClose();
    },
  };
  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/40 pt-[10vh]" onMouseDown={onClose}>
      <div
        className="flex max-h-[70vh] w-[min(640px,92vw)] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-card shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "ArrowDown") setSel((v) => Math.min(v + 1, Math.max(0, s.results.length - 1)));
          if (e.key === "ArrowUp") setSel((v) => Math.max(0, v - 1));
          if (e.key === "Enter" && s.results[sel]) go.go(s.results[sel]);
        }}
      >
        <div className="flex items-start gap-2 border-b border-border p-3">
          <div className="min-w-0 flex-1">
            <SearchInput s={s} autoFocus />
          </div>
          <button className="mt-1.5 rounded p-1 text-text-2 hover:bg-bg-hover hover:text-text-1" title="Fechar" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {s.query.trim() ? (
            <SearchResults s={s} panes={panes} where={where} actions={go} selected={sel} />
          ) : (
            <div className="px-3 py-4 text-center text-text-3">
              Digite parte do título, da pasta, do nome da aba, o número do pane (#28) ou, marcando a opção, um texto que está na tela.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
