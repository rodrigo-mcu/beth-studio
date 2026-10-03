import { useEffect, useMemo, useState } from "react";
import { Download, FolderOpen, Loader2, RefreshCw } from "lucide-react";
import type { Connection } from "@/lib/connection";
import { loadVoice, saveVoice } from "@/lib/voice";
import { formatSeconds, formatUSD } from "@/lib/voicePipeline";
import { FUNC_LABEL, filterUsage, type UsageRecord, type UsageSummary } from "@/lib/aiUsage";
import { cn } from "@/lib/utils";

/** Configuracoes → "Uso e custos de IA". */
export function AIUsageSection({ conn, onMessage }: { conn: Connection; onMessage: (m: string) => void }) {
  const [s, setS] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [fn, setFn] = useState<"" | "transcricao" | "correcao" | "banco">("");
  const [limit, setLimit] = useState("");

  const load = () => {
    setLoading(true);
    conn
      .api<UsageSummary>("/api/ai-usage?recent=500")
      .then((x) => {
        setS(x);
        setLimit(x.limit_usd ? String(x.limit_usd).replace(".", ",") : "");
      })
      .catch((e: Error) => onMessage(`Erro: ${e.message}`))
      .finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveLimit = async () => {
    const n = Number(limit.replace(",", ".") || "0");
    if (!Number.isFinite(n) || n < 0) return onMessage("Limite inválido");
    try {
      const snap = await loadVoice(conn);
      await saveVoice(conn, { ...snap.settings, monthly_limit_usd: n });
      onMessage(n ? `Alerta mensal: ${formatUSD(n)}` : "Alerta mensal desligado");
      load();
    } catch (e) {
      onMessage(`Erro: ${(e as Error).message}`);
    }
  };

  const rows = useMemo(() => (s ? filterUsage(s.recent ?? [], q, fn) : []), [s, q, fn]);
  const maxDay = Math.max(0.000001, ...(s?.daily ?? []).map((d) => d.usd));

  if (!s) return <div className="flex items-center gap-2 p-4 text-text-2">{loading && <Loader2 size={14} className="animate-spin" />} Carregando…</div>;
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {(
          [
            ["Hoje", s.today],
            ["7 dias", s.week],
            ["Este mês", s.month],
            ["Total", s.all],
          ] as const
        ).map(([l, t]) => (
          <div key={l} className={cn("rounded border bg-bg-panel p-2.5", l === "Este mês" && s.over_limit ? "border-status-warn" : "border-border")}>
            <div className="text-[11px] text-text-3">{l}</div>
            <div className="text-[17px] font-semibold tabular-nums text-text-1">{formatUSD(t.usd)}</div>
            <div className="text-[11px] text-text-2">{t.calls} chamadas</div>
          </div>
        ))}
      </div>
      {s.over_limit && <div className="rounded bg-status-warn/15 p-2 text-[12px] text-status-warn">O gasto deste mês passou do limite de {formatUSD(s.limit_usd)} (só um aviso: nada é bloqueado).</div>}

      <section>
        <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-text-2">Por dia (30 dias)</div>
        <div className="flex h-20 items-end gap-px rounded border border-border bg-bg-panel p-1">
          {s.daily.map((d) => (
            <div key={d.key} className="flex h-full flex-1 items-end" title={`${d.key.split("-").reverse().join("/")}: ${formatUSD(d.usd)} · ${d.calls} chamadas`}>
              <div className={cn("w-full rounded-t-sm", d.usd > 0 ? "bg-accent" : "bg-bg-hover")} style={{ height: `${d.usd > 0 ? Math.max(4, (d.usd / maxDay) * 100) : 2}%` }} />
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-3 md:grid-cols-3">
        {(
          [
            ["Por provedor", s.by_provider],
            ["Por função", s.by_func],
            ["Por modelo", s.by_model],
          ] as const
        ).map(([title, gs]) => (
          <section key={title}>
            <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-text-2">{title}</div>
            <ul className="space-y-0.5 text-[12px]">
              {(gs ?? []).slice(0, 8).map((g) => (
                <li key={g.key} className="flex gap-2">
                  <span className="min-w-0 flex-1 truncate text-text-1" title={g.key}>
                    {FUNC_LABEL[g.key] ?? g.key}
                  </span>
                  <span className="tabular-nums text-text-2">{formatUSD(g.usd)}</span>
                  <span className="w-10 text-right tabular-nums text-text-3">{g.calls}</span>
                </li>
              ))}
              {(gs ?? []).length === 0 && <li className="text-text-3">nada ainda</li>}
            </ul>
          </section>
        ))}
      </div>

      <section>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-semibold uppercase tracking-wide text-text-2">Últimas chamadas</span>
          <div className="flex-1" />
          <select className="h-7 rounded border border-border bg-bg-term px-1 text-[12px] text-text-1" value={fn} onChange={(e) => setFn(e.target.value as typeof fn)}>
            <option value="">todas</option>
            <option value="transcricao">transcrição</option>
            <option value="correcao">correção</option>
            <option value="banco">assistente de banco</option>
          </select>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="filtrar (provedor, modelo, erro…)"
            className="h-7 w-52 rounded border border-border bg-bg-term px-2 text-[12px] text-text-1 outline-none focus:border-accent"
          />
        </div>
        <div className="max-h-72 overflow-auto rounded border border-border">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-bg-card text-text-3">
              <tr>
                <th className="px-1.5 py-1 text-left font-normal">quando</th>
                <th className="px-1.5 text-left font-normal">função</th>
                <th className="px-1.5 text-left font-normal">provedor · modelo</th>
                <th className="px-1.5 text-right font-normal">uso</th>
                <th className="px-1.5 text-right font-normal">tempo</th>
                <th className="px-1.5 text-right font-normal">custo</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <Row key={i} r={r} />
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-1.5 py-3 text-center text-text-3">
                    Nenhuma chamada registrada.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-text-2">Avisar quando o mês passar de US$</span>
        <input
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          onBlur={() => void saveLimit()}
          placeholder="sem limite"
          className="h-7 w-24 rounded border border-border bg-bg-term px-2 text-[12px] text-text-1 outline-none focus:border-accent"
        />
        <span className="text-[11px] text-text-3">(aviso no “Falar”; não bloqueia)</span>
        <div className="flex-1" />
        <button className="flex items-center gap-1 rounded bg-bg-hover px-2.5 py-1 text-[12px] text-text-1 hover:bg-border" onClick={load}>
          <RefreshCw size={12} className={cn(loading && "animate-spin")} /> Atualizar
        </button>
        <button
          className="flex items-center gap-1 rounded bg-bg-hover px-2.5 py-1 text-[12px] text-text-1 hover:bg-border"
          onClick={() =>
            void conn
              .api<{ path: string }>("/api/ai-usage/export", {})
              .then((r) => onMessage(`CSV salvo: ${r.path}`))
              .catch((e: Error) => onMessage(`Erro: ${e.message}`))
          }
        >
          <Download size={12} /> Exportar CSV
        </button>
        <button
          className="flex items-center gap-1 rounded bg-bg-hover px-2.5 py-1 text-[12px] text-text-1 hover:bg-border"
          onClick={() => void conn.api("/api/ai-usage/open", {}).catch((e: Error) => onMessage(`Erro: ${e.message}`))}
        >
          <FolderOpen size={12} /> Abrir pasta
        </button>
      </section>
      <p className="text-[11px] text-text-3">
        Registro em {s.file} (uma linha por chamada paga; nunca guarda áudio nem texto). Custos pelo catálogo de preços do momento; “estimado” quando o provedor não
        informa o uso.
      </p>
    </div>
  );
}

function Row({ r }: { r: UsageRecord }) {
  const d = new Date(r.ts);
  const use =
    r.func === "transcricao"
      ? `${(r.audio_sec ?? 0).toFixed(1).replace(".", ",")} s de áudio`
      : `${r.in_tokens ?? 0}/${r.out_tokens ?? 0} tokens`;
  return (
    <tr className={cn("border-t border-border", !r.ok && "text-status-err")} title={r.error ?? ""}>
      <td className="whitespace-nowrap px-1.5 py-0.5 text-text-2">{d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
      <td className="px-1.5">
        {FUNC_LABEL[r.func] ?? r.func}
        {r.test ? " (teste)" : ""}
      </td>
      <td className="max-w-[240px] truncate px-1.5" title={`${r.provider} · ${r.model}`}>
        {r.provider} · {r.model}
      </td>
      <td className="whitespace-nowrap px-1.5 text-right">
        {use}
        {r.estimated ? "*" : ""}
      </td>
      <td className="whitespace-nowrap px-1.5 text-right">{formatSeconds(r.ms)}</td>
      <td className="whitespace-nowrap px-1.5 text-right tabular-nums">{r.ok ? formatUSD(r.cost_usd) : "erro"}</td>
    </tr>
  );
}
