// Seletor de modelos em cards: tipos do /api/voice/catalog, precos,
// selos e busca. Funcoes puras testadas em tests/modelCatalog.test.ts.

import type { Connection } from "./connection";

export type ModelFunc = "stt" | "llm";

export interface ModelCard {
  id: string;
  name: string;
  func: ModelFunc;
  /** USD por minuto de audio (-1 = desconhecido) */
  per_min: number;
  /** USD por 1M tokens (-1 = desconhecido) */
  in_per_m: number;
  out_per_m: number;
  context?: number;
}

export interface ModelCatalog {
  provider: string;
  source: "api" | "reference";
  as_of: string;
  pricing_url?: string;
  note?: string;
  models: ModelCard[];
}

export const loadCatalogFor = (conn: Connection, provider: string, refresh = false) =>
  conn.api<ModelCatalog>("/api/voice/catalog", { provider, refresh });
export const openPricing = (conn: Connection, provider: string) => conn.api<{ url: string }>("/api/voice/open-pricing", { provider });

export type Badge = "recomendado" | "rápido" | "barato" | "mais lento";

const FAST = /turbo|instant|mini|flash|lite|haiku|small|nano|(^|[^0-9.])(0\.6|1|1\.7|3|7|8)b/i;

/** Modelo grande (>= 70B parametros ou "405B"...): costuma ser mais lento. */
export function isLarge(id: string): boolean {
  const sizes = [...id.matchAll(/(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z])/g)].map((m) => Number(m[1]));
  return sizes.some((n) => n >= 70);
}

/** Custo usado para comparar: minuto de audio, ou media entrada+saida. */
export function costOf(m: ModelCard): number {
  if (m.func === "stt") return m.per_min;
  if (m.in_per_m < 0 && m.out_per_m < 0) return -1;
  return (Math.max(0, m.in_per_m) + Math.max(0, m.out_per_m)) / 2;
}

/** Selos de cada card (por funcao). */
export function badgesFor(models: ModelCard[], recommended: string[]): Map<string, Badge[]> {
  const out = new Map<string, Badge[]>();
  for (const f of ["stt", "llm"] as ModelFunc[]) {
    const ms = models.filter((m) => m.func === f);
    const priced = ms.map(costOf).filter((c) => c >= 0).sort((a, b) => a - b);
    const cheapCut = priced.length >= 3 ? priced[Math.floor((priced.length - 1) * 0.25)] : -1;
    for (const m of ms) {
      const b: Badge[] = [];
      if (recommended.includes(m.id)) b.push("recomendado");
      if (FAST.test(m.id)) b.push("rápido");
      const c = costOf(m);
      if (cheapCut >= 0 && c >= 0 && c <= cheapCut) b.push("barato");
      if (f === "llm" && isLarge(m.id)) b.push("mais lento");
      out.set(m.id, b);
    }
  }
  return out;
}

function fold(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Busca (nome/id, sem acento) + filtro por funcao; recomendados primeiro, depois o mais barato. */
export function filterModels(models: ModelCard[], query: string, func: ModelFunc | "all", recommended: string[]): ModelCard[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const hit = models.filter((m) => (func === "all" || m.func === func) && words.every((w) => fold(`${m.name} ${m.id}`).includes(w)));
  const rank = (m: ModelCard) => {
    const r = recommended.indexOf(m.id);
    return r >= 0 ? r : 1000;
  };
  return hit.sort((a, b) => {
    const ra = rank(a) - rank(b);
    if (ra) return ra;
    const ca = costOf(a);
    const cb = costOf(b);
    if (ca < 0 !== cb < 0) return ca < 0 ? 1 : -1;
    if (ca !== cb) return ca - cb;
    return a.id.localeCompare(b.id);
  });
}

export function usd(v: number): string {
  if (v < 0) return "—";
  if (v === 0) return "grátis";
  if (v < 0.01) return `US$ ${v.toFixed(4).replace(".", ",")}`;
  return `US$ ${v.toFixed(2).replace(".", ",")}`;
}

/** Linha de preco do card. */
export function priceLine(m: ModelCard): string {
  if (m.func === "stt") return m.per_min < 0 ? "preço: ver site" : `${usd(m.per_min)} / min de áudio · ${usd(m.per_min * 60)} / hora`;
  if (m.in_per_m < 0 && m.out_per_m < 0) return "preço: ver site";
  return `${usd(m.in_per_m)} entrada · ${usd(m.out_per_m)} saída / 1M tokens`;
}

export function contextLabel(n?: number): string {
  if (!n) return "";
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0).replace(".", ",")}M tokens` : `${Math.round(n / 1000)}k tokens`;
}

/** Rodape: de onde vieram os precos. */
export function sourceLine(c: ModelCatalog): string {
  if (c.source === "api") {
    const d = new Date(c.as_of);
    return `Preços da API do provedor, atualizados ${Number.isNaN(d.getTime()) ? c.as_of : d.toLocaleString("pt-BR")} (cache de 24 h).`;
  }
  const [y, mo] = c.as_of.split("-");
  return `Preços de referência de ${mo}/${y} — confira no site do provedor.`;
}
