import { useEffect, useState } from "react";
import { Database } from "lucide-react";
import type { Connection } from "@/lib/connection";
import { ModelPicker } from "./ModelPicker";
import { loadVoice, saveVoice, type ProviderView, type VoiceSettings } from "@/lib/voice";

/** Configurações → Banco de dados: modelo do assistente de SQL. */
export function DbAssistSettings({ conn, onProviders }: { conn: Connection; onProviders: () => void }) {
  const [v, setV] = useState<VoiceSettings | null>(null);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [err, setErr] = useState("");
  const [picker, setPicker] = useState(false);

  useEffect(() => {
    void loadVoice(conn)
      .then((s) => {
        setV(s.settings);
        setProviders(s.providers);
      })
      .catch((e: Error) => setErr(e.message));
  }, [conn]);

  const patch = (p: Partial<VoiceSettings>) => {
    if (!v) return;
    const next = { ...v, ...p };
    setV(next);
    setErr("");
    void saveVoice(conn, next).catch((e: Error) => setErr(e.message));
  };

  if (!v) return <div className="p-4 text-[13px] text-text-3">{err || "Carregando…"}</div>;
  const llm = providers.filter((p) => p.llm);
  const cur = llm.find((p) => p.id === (v.db_assist_provider || ""));
  const models = cur?.prefs.llm_models?.length ? cur.prefs.llm_models : cur?.llm_models ?? [];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-2 text-[15px] font-semibold text-text-1">
        <Database size={16} className="text-accent-text" /> Assistente de banco
      </div>
      <p className="mb-3 max-w-xl text-[13px] text-text-2">
        No editor SQL, a varinha corrige a sintaxe e o ponto de interrogação responde dúvidas sobre o banco da conexão aberta (MySQL, PostgreSQL, SQL Server ou
        SQLite). O modelo daqui é só desse assistente. A correção de voz continua com o modelo de Voz e IA. Vai o SQL e os nomes de tabelas e colunas — não as
        linhas da tabela. A chave é a mesma cadastrada em Provedores de IA.
      </p>
      <button
        className={`mb-3 flex w-full max-w-xl items-start gap-2 rounded-md border p-2.5 text-left ${v.db_assist_enabled ? "border-accent bg-accent-soft" : "border-border bg-bg-panel hover:bg-bg-hover"}`}
        onClick={() => patch({ db_assist_enabled: !v.db_assist_enabled })}
      >
        <span className={`mt-1 h-3 w-3 shrink-0 rounded-full border-2 ${v.db_assist_enabled ? "border-accent bg-accent" : "border-border-strong"}`} />
        <span>
          <span className="block text-[13px] text-text-1">Usar um modelo no Banco de dados</span>
          <span className="block text-[11px] text-text-3">Desligado, os botões do editor avisam para escolher um modelo aqui.</span>
        </span>
      </button>
      <div className="flex max-w-xl flex-col gap-2">
        <label className="flex items-center gap-2 text-[13px] text-text-2">
          <span className="w-24 shrink-0">Provedor</span>
          <select
            className="h-8 min-w-0 flex-1 rounded border border-border bg-bg-term px-2 text-text-1"
            value={v.db_assist_provider || ""}
            onChange={(e) => {
              const id = e.target.value;
              const p = llm.find((x) => x.id === id);
              const first = p?.prefs.llm_models?.[0] || p?.llm_models?.[0] || "";
              patch({ db_assist_provider: id, db_assist_model: first });
            }}
          >
            <option value="">escolher…</option>
            {llm.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.configured ? "" : " (sem chave)"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[13px] text-text-2">
          <span className="w-24 shrink-0">Modelo</span>
          <input
            list="db-assist-models"
            value={v.db_assist_model || ""}
            onChange={(e) => patch({ db_assist_model: e.target.value })}
            placeholder={models[0] || "id do modelo"}
            className="h-8 min-w-0 flex-1 rounded border border-border bg-bg-term px-2 font-mono text-[12px] text-text-1 outline-none focus:border-accent"
          />
          <datalist id="db-assist-models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <button
            className="h-8 shrink-0 rounded bg-bg-hover px-2 text-[12px] text-text-1 hover:bg-border disabled:opacity-40"
            disabled={!cur}
            onClick={() => setPicker(true)}
          >
            Escolher com preços…
          </button>
        </label>
        {cur && !cur.configured && (
          <button className="self-start text-[12px] text-accent-text hover:underline" onClick={onProviders}>
            Cadastrar a chave de {cur.name} em Provedores de IA
          </button>
        )}
        {err && <p className="text-[12px] text-status-err">{err}</p>}
      </div>
      {picker && cur && (
        <ModelPicker
          conn={conn}
          provider={cur.id}
          providerName={cur.name}
          func="llm"
          canSTT={cur.stt}
          canLLM={cur.llm}
          recommended={models}
          current={{ llm: v.db_assist_model }}
          onPick={(_fn, id) => {
            patch({ db_assist_model: id });
            setPicker(false);
          }}
          onClose={() => setPicker(false)}
        />
      )}
    </div>
  );
}
