// Uso e custos de IA (GET /api/ai-usage). Funcoes puras em tests/aiUsage.test.ts.

export interface UsageRecord {
  ts: string;
  func: string;
  test?: boolean;
  provider: string;
  model: string;
  audio_sec?: number;
  in_tokens?: number;
  out_tokens?: number;
  estimated?: boolean;
  ms: number;
  ttfb_ms?: number;
  ok: boolean;
  error?: string;
  cost_usd: number;
  price_source: string;
  pane?: number;
}

export interface UsageTotals {
  usd: number;
  calls: number;
}

export interface UsageGroup extends UsageTotals {
  key: string;
}

export interface UsageSummary {
  today: UsageTotals;
  week: UsageTotals;
  month: UsageTotals;
  all: UsageTotals;
  by_provider: UsageGroup[] | null;
  by_model: UsageGroup[] | null;
  by_func: UsageGroup[] | null;
  daily: UsageGroup[];
  recent: UsageRecord[] | null;
  limit_usd: number;
  over_limit: boolean;
  file: string;
}

export const FUNC_LABEL: Record<string, string> = { transcricao: "transcrição", correcao: "correção", banco: "assistente de banco" };

function fold(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Filtro da tabela: funcao + texto (provedor, modelo, erro, "teste"), sem acento. */
export function filterUsage(recs: UsageRecord[], query: string, func: string): UsageRecord[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return recs.filter((r) => {
    if (func && r.func !== func) return false;
    const hay = fold(`${r.provider} ${r.model} ${FUNC_LABEL[r.func] ?? r.func} ${r.error ?? ""} ${r.test ? "teste" : ""} ${r.ok ? "ok" : "erro"}`);
    return words.every((w) => hay.includes(w));
  });
}
