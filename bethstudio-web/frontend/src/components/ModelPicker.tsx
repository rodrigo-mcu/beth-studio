import { useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, Loader2, RefreshCw, Search, X } from "lucide-react";
import type { Connection } from "@/lib/connection";
import {
  badgesFor,
  contextLabel,
  filterModels,
  loadCatalogFor,
  openPricing,
  priceLine,
  sourceLine,
  type Badge,
  type ModelCard,
  type ModelCatalog,
  type ModelFunc,
} from "@/lib/modelCatalog";
import { cn } from "@/lib/utils";

const SHOW_STEP = 60;

const BADGE_CLASS: Record<Badge, string> = {
  recomendado: "bg-accent-soft text-accent-text",
  rápido: "bg-status-warn/15 text-status-warn",
  barato: "bg-status-ok/15 text-status-ok",
  "mais lento": "bg-bg-hover text-text-2",
};

interface Props {
  conn: Connection;
  provider: string;
  providerName: string;
  /** funcao inicial do filtro */
  func: ModelFunc | "all";
  /** quais funcoes o provedor faz */
  canSTT: boolean;
  canLLM: boolean;
  recommended: string[];
  /** modelo atual de cada funcao (para marcar o card) */
  current: { stt?: string; llm?: string };
  onPick: (func: ModelFunc, id: string) => void;
  onClose: () => void;
}

/** Seletor de modelos em cards, com preco, contexto e selos. */
export function ModelPicker(p: Props) {
  const [cat, setCat] = useState<ModelCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [func, setFunc] = useState<ModelFunc | "all">(p.func);
  const [show, setShow] = useState(SHOW_STEP);

  const load = (refresh: boolean) => {
    setLoading(true);
    setError(null);
    loadCatalogFor(p.conn, p.provider, refresh)
      .then(setCat)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => load(false), [p.provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const badges = useMemo(() => (cat ? badgesFor(cat.models, p.recommended) : new Map<string, Badge[]>()), [cat, p.recommended]);
  const list = useMemo(() => (cat ? filterModels(cat.models, q, func, p.recommended) : []), [cat, q, func, p.recommended]);
  const funcs: { id: ModelFunc | "all"; label: string }[] = [
    { id: "all", label: "Todos" },
    ...(p.canSTT ? [{ id: "stt" as const, label: "Transcrição" }] : []),
    ...(p.canLLM ? [{ id: "llm" as const, label: "Correção" }] : []),
  ];

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/50 pt-[4vh]" onMouseDown={p.onClose}>
      <div
        className="flex h-[88vh] w-[min(1000px,96vw)] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-card shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && p.onClose()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <div className="flex-1 text-[15px] font-semibold text-text-1">Modelos de {p.providerName}</div>
          <button className="rounded p-1 text-text-2 hover:bg-bg-hover hover:text-text-1" title="Fechar" onClick={p.onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
          <div className="flex h-8 min-w-[220px] flex-1 items-center gap-2 rounded border border-border bg-bg-term px-2">
            <Search size={14} className="text-text-3" />
            <input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setShow(SHOW_STEP);
              }}
              placeholder="Buscar modelo (nome ou id)…"
              className="min-w-0 flex-1 bg-transparent text-text-1 outline-none"
            />
          </div>
          <div className="flex overflow-hidden rounded border border-border">
            {funcs.map((f) => (
              <button
                key={f.id}
                className={cn("px-3 py-1 text-[12px]", func === f.id ? "bg-accent-soft font-semibold text-accent-text" : "text-text-2 hover:bg-bg-hover")}
                onClick={() => {
                  setFunc(f.id);
                  setShow(SHOW_STEP);
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            className="flex items-center gap-1 rounded bg-bg-hover px-2 py-1 text-[12px] text-text-1 hover:bg-border disabled:opacity-50"
            disabled={loading}
            onClick={() => load(true)}
            title="Buscar os preços de novo"
          >
            <RefreshCw size={12} className={cn(loading && "animate-spin")} /> Atualizar
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading && !cat && (
            <div className="flex items-center justify-center gap-2 py-10 text-text-2">
              <Loader2 size={16} className="animate-spin" /> Buscando modelos e preços…
            </div>
          )}
          {error && <div className="mb-2 rounded bg-status-err/10 p-2 text-status-err">{error}</div>}
          {cat &&
            cat.source === "api" &&
            (["stt", "llm"] as const)
              .filter((f) => p.current[f] && !cat.models.some((m) => m.id === p.current[f]))
              .map((f) => (
                <div key={f} className="mb-2 rounded bg-status-warn/15 p-2 text-[12px] text-status-warn">
                  O modelo em uso para {f === "stt" ? "transcrição" : "correção"} ({p.current[f]}) não está mais no catálogo de {p.providerName}: escolha outro
                  abaixo.
                </div>
              ))}
          {cat && (func === "stt" || func === "all") && p.canSTT && p.provider !== "groq" && (
            <div className="mb-2 text-[11px] text-text-3">
              Só informação: para transcrição mais rápida, o Groq (whisper-large-v3-turbo) costuma responder em cerca de 1 s.
            </div>
          )}
          {cat && (func === "llm" || func === "all") && p.canLLM && (
            <div className="mb-2 text-[11px] text-text-3">Para a correção, modelos pequenos (“rápido”) respondem em poucos segundos; os “mais lento” (≥ 70B) podem levar dezenas.</div>
          )}
          {cat && list.length === 0 && <div className="py-10 text-center text-text-2">Nenhum modelo encontrado.</div>}
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {list.slice(0, show).map((m) => (
              <Card
                key={`${m.func}:${m.id}`}
                m={m}
                provider={p.providerName}
                badges={badges.get(m.id) ?? []}
                selected={(m.func === "stt" ? p.current.stt : p.current.llm) === m.id}
                onPick={() => p.onPick(m.func, m.id)}
              />
            ))}
          </div>
          {list.length > show && (
            <div className="mt-3 text-center">
              <button className="rounded bg-bg-hover px-3 py-1 text-[12px] text-text-1 hover:bg-border" onClick={() => setShow((n) => n + SHOW_STEP)}>
                Mostrar mais ({list.length - show} restantes)
              </button>
            </div>
          )}
        </div>
        {cat && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2 text-[11px] text-text-3">
            <span className="min-w-0 flex-1">
              {sourceLine(cat)} {cat.note && <span className="text-status-warn">{cat.note}</span>}
            </span>
            {cat.pricing_url && (
              <button
                className="flex items-center gap-1 rounded bg-bg-hover px-2 py-1 text-text-1 hover:bg-border"
                onClick={() => void openPricing(p.conn, p.provider).catch(() => undefined)}
              >
                <ExternalLink size={12} /> Página de preços
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ m, provider, badges, selected, onPick }: { m: ModelCard; provider: string; badges: Badge[]; selected: boolean; onPick: () => void }) {
  return (
    <button
      className={cn(
        "flex flex-col gap-1 rounded-md border p-2.5 text-left",
        selected ? "border-accent bg-accent-soft" : "border-border bg-bg-panel hover:border-border-strong hover:bg-bg-hover",
      )}
      onClick={onPick}
      title={selected ? "Modelo em uso" : `Usar ${m.id} para ${m.func === "stt" ? "transcrição" : "correção"}`}
    >
      <div className="flex items-start gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-1">{m.name}</span>
        {selected && <Check size={14} className="shrink-0 text-accent-text" />}
      </div>
      <div className="truncate font-mono text-[11px] text-text-3" title={m.id}>
        {m.id}
      </div>
      <div className="text-[11px] text-text-2">
        {provider} · {m.func === "stt" ? "transcrição" : "correção (chat)"}
        {m.context ? ` · contexto ${contextLabel(m.context)}` : ""}
      </div>
      <div className="text-[12px] text-text-1">{priceLine(m)}</div>
      {badges.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {badges.map((b) => (
            <span key={b} className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", BADGE_CLASS[b])}>
              {b}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
