import { useEffect, useMemo, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import type { Connection } from "@/lib/connection";
import { filterVocab, loadTechVocab, type TechVocab } from "@/lib/techVocab";

/** "Ver lista": vocabulario tecnico padrao (somente leitura), com busca e categorias. */
export function TechVocabDialog({ conn, onClose }: { conn: Connection; onClose: () => void }) {
  const [data, setData] = useState<TechVocab | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    loadTechVocab(conn)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [conn]);
  const cats = useMemo(() => (data ? filterVocab(data.categories, q) : []), [data, q]);
  const top = useMemo(() => new Set(data?.top ?? []), [data]);

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/50 pt-[5vh]" onMouseDown={onClose}>
      <div
        className="flex h-[85vh] w-[min(820px,96vw)] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-card shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <div className="flex-1 text-[15px] font-semibold text-text-1">
            Vocabulário técnico padrão {data && <span className="font-normal text-text-3">({data.total} termos)</span>}
          </div>
          <button className="rounded p-1 text-text-2 hover:bg-bg-hover hover:text-text-1" title="Fechar" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="border-b border-border px-4 py-2">
          <div className="flex h-8 items-center gap-2 rounded border border-border bg-bg-term px-2">
            <Search size={14} className="text-text-3" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar termo…"
              className="min-w-0 flex-1 bg-transparent text-text-1 outline-none"
            />
          </div>
          <p className="mt-1 text-[11px] text-text-3">
            Somente leitura. Vai inteiro no prompt da correção; os marcados em negrito também vão como dica para a transcrição. Termos do seu projeto
            ficam na caixa “Vocabulário do projeto”.
          </p>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {!data && !error && (
            <div className="flex items-center gap-2 text-text-2">
              <Loader2 size={14} className="animate-spin" /> Carregando…
            </div>
          )}
          {error && <div className="rounded bg-status-err/10 p-2 text-status-err">{error}</div>}
          {data && cats.length === 0 && <div className="text-text-2">Nenhum termo encontrado.</div>}
          {cats.map((c) => (
            <section key={c.name}>
              <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-text-2">
                {c.name} <span className="font-normal text-text-3">({c.terms.length})</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {c.terms.map((t) => (
                  <span
                    key={t}
                    className={`rounded bg-bg-panel px-1.5 py-0.5 font-mono text-[11px] ${top.has(t) ? "font-bold text-text-1" : "text-text-2"}`}
                  >
                    {t}
                  </span>
                ))}
              </div>
            </section>
          ))}
          {data && !q.trim() && (
            <section>
              <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-text-2">Exemplos fonéticos (no prompt da correção)</div>
              <ul className="space-y-0.5 text-[12px]">
                {data.phonetic.map((p) => (
                  <li key={p.term + p.heard} className="text-text-2">
                    “{p.heard}” → <span className="font-mono text-text-1">{p.term}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
