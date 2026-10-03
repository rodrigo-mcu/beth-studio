import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, KeyRound, Loader2, Mic, RotateCcw, Search, Server, X } from "lucide-react";
import type { Connection } from "@/lib/connection";
import {
  LANGUAGES,
  fetchModels,
  loadVoice,
  logoutAccount,
  openKeysPage,
  pollAccountLogin,
  saveKey,
  saveVoice,
  startAccountLogin,
  testProvider,
  type ProviderView,
  type VoiceSettings,
  type VoiceSnapshot,
} from "@/lib/voice";
import { copyText } from "@/lib/clipboard";
import { openExternal } from "@/lib/links";
import { cn } from "@/lib/utils";
import { MicPicker } from "./MicPicker";
import { ModelPicker } from "./ModelPicker";
import { PipelineTest } from "./PipelineTest";
import { TechVocabDialog } from "./TechVocabDialog";
import type { ModelFunc } from "@/lib/modelCatalog";

type Tab = "voz" | "provedores";

/** "Voz e IA": transcricao, correcao, prompt, vocabulario, prefixo e provedores. */
export function VoiceSettingsDialog({
  conn,
  onClose,
  initialTab = "voz",
  embedded,
}: {
  conn: Connection;
  onClose: () => void;
  initialTab?: Tab;
  /** dentro da tela de Configuracoes: so' a secao pedida, sem moldura */
  embedded?: boolean;
}) {
  const [snap, setSnap] = useState<VoiceSnapshot | null>(null);
  const [v, setV] = useState<VoiceSettings | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadVoice(conn)
      .then((s) => {
        setSnap(s);
        setV(s.settings);
      })
      .catch((e: Error) => setMsg(`Erro: ${e.message}`));
  }, [conn]);

  const apply = (s: VoiceSnapshot) => {
    setSnap(s);
    setV(s.settings);
  };
  const save = (next: VoiceSettings) => {
    setV(next);
    setSaving(true);
    saveVoice(conn, next)
      .then((s) => {
        apply(s);
        setMsg("Salvo");
      })
      .catch((e: Error) => setMsg(`Erro: ${e.message}`))
      .finally(() => setSaving(false));
  };
  const patch = (p: Partial<VoiceSettings>) => v && save({ ...v, ...p });

  const body = (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {embedded && (saving || msg) && (
        <div className="mb-2 flex items-center gap-2 text-[12px] text-text-2">
          {saving && <Loader2 size={12} className="animate-spin" />}
          {msg}
        </div>
      )}
      {!snap || !v ? (
        <div className="text-text-2">Carregando…</div>
      ) : tab === "voz" ? (
        <VoiceTab conn={conn} snap={snap} v={v} patch={patch} goProviders={() => setTab("provedores")} />
      ) : (
        <ProvidersTab conn={conn} snap={snap} v={v} save={save} apply={apply} setMsg={setMsg} />
      )}
    </div>
  );
  if (embedded) return body;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 pt-[4vh]" onMouseDown={onClose}>
      <div
        className="flex max-h-[92vh] w-[min(860px,95vw)] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-card shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <Mic size={16} className="text-accent-text" />
          <div className="text-[15px] font-semibold text-text-1">Voz e IA</div>
          <div className="ml-4 flex gap-1">
            {(["voz", "provedores"] as Tab[]).map((t) => (
              <button
                key={t}
                className={cn("rounded px-3 py-1 text-[13px]", tab === t ? "bg-accent-soft font-semibold text-text-1" : "text-text-2 hover:bg-bg-hover")}
                onClick={() => setTab(t)}
              >
                {t === "voz" ? "Microfone" : "Provedores de IA"}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          {saving && <Loader2 size={14} className="animate-spin text-text-3" />}
          {msg && <span className="text-[12px] text-text-2">{msg}</span>}
          <button className="rounded p-1 text-text-2 hover:bg-bg-hover hover:text-text-1" title="Fechar" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {body}
      </div>
    </div>
  );
}

/** Recomendados do provedor (os sugeridos do catalogo e os do usuario). */
function recommendedOf(p: ProviderView | undefined): string[] {
  if (!p) return [];
  return [...(p.prefs.stt_models ?? []), ...(p.stt_models ?? []), ...(p.prefs.llm_models ?? []), ...(p.llm_models ?? [])];
}

function VoiceTab({
  conn,
  snap,
  v,
  patch,
  goProviders,
}: {
  conn: Connection;
  snap: VoiceSnapshot;
  v: VoiceSettings;
  patch: (p: Partial<VoiceSettings>) => void;
  goProviders: () => void;
}) {
  const stt = snap.providers.filter((p) => p.stt);
  const llm = snap.providers.filter((p) => p.llm);
  const sttP = snap.providers.find((p) => p.id === v.stt_provider);
  const llmP = snap.providers.find((p) => p.id === v.llm_provider);
  const models = (p: ProviderView | undefined, kind: "stt" | "llm") =>
    (kind === "stt" ? (p?.prefs.stt_models?.length ? p.prefs.stt_models : p?.stt_models) : p?.prefs.llm_models?.length ? p.prefs.llm_models : p?.llm_models) ?? [];
  // campos de texto grandes: salva ao sair do campo
  const [prompt, setPrompt] = useState(v.prompt);
  const [vocab, setVocab] = useState(v.vocabulary);
  const [prefix, setPrefix] = useState(v.prefix_text);
  const [picker, setPicker] = useState<ModelFunc | null>(null);
  const [showTech, setShowTech] = useState(false);
  const pickP = picker === "stt" ? sttP : llmP;

  return (
    <div className="space-y-5">
      {picker && pickP && (
        <ModelPicker
          conn={conn}
          provider={pickP.id}
          providerName={pickP.name}
          func={picker}
          canSTT={picker === "stt"}
          canLLM={picker === "llm"}
          recommended={recommendedOf(pickP)}
          current={{ stt: v.stt_model, llm: v.llm_model }}
          onPick={(f, id) => {
            patch(f === "stt" ? { stt_model: id } : { llm_model: id });
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
      <Section title="Microfone">
        <MicPicker
          conn={conn}
          value={{ id: v.mic_device_id ?? "", label: v.mic_label ?? "" }}
          onChange={(c) => patch({ mic_device_id: c.id, mic_label: c.label })}
          withTest
        />
        <p className="mt-1 text-[11px] text-text-3">Os nomes dos microfones aparecem depois da primeira permissão. “Testar microfone” mede o sinal por 5 s.</p>
      </Section>
      <Section title="Testar tudo">
        <p className="mb-2 text-[12px] text-text-2">
          Roda o caminho inteiro — microfone (ou áudio de exemplo), transcrição, correção e o texto final — sem enviar nada ao terminal, com tempos e
          custo de cada etapa. Só roda quando você clica (gasta alguns centavos).
        </p>
        <PipelineTest conn={conn} v={v} providerName={(id) => snap.providers.find((p) => p.id === id)?.name ?? id} />
      </Section>
      <Section title="Transcrição (voz → texto)">
        <Row label="Provedor">
          <ProviderSelect list={stt} value={v.stt_provider} onChange={(id) => patch({ stt_provider: id, stt_model: models(snap.providers.find((p) => p.id === id), "stt")[0] ?? "" })} />
          <KeyStatus p={sttP} onGo={goProviders} />
        </Row>
        <Row label="Modelo">
          <ModelInput value={v.stt_model} options={models(sttP, "stt")} onChange={(m) => patch({ stt_model: m })} id="stt-models" />
          <Btn onClick={() => setPicker("stt")}>Escolher com preços…</Btn>
        </Row>
        <Row label="Idioma">
          <select
            className="h-8 rounded border border-border bg-bg-term px-2 text-text-1"
            value={v.language}
            onChange={(e) => patch({ language: e.target.value })}
          >
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </Row>
      </Section>

      <Section title="Correção por IA (opcional)">
        <Toggle on={v.llm_enabled} onClick={() => patch({ llm_enabled: !v.llm_enabled })} label="Passar o texto num modelo para corrigir erros de reconhecimento" />
        {v.llm_enabled && (
          <>
            <Row label="Provedor">
              <ProviderSelect list={llm} value={v.llm_provider} onChange={(id) => patch({ llm_provider: id, llm_model: models(snap.providers.find((p) => p.id === id), "llm")[0] ?? "" })} />
              <KeyStatus p={llmP} onGo={goProviders} />
            </Row>
            <Row label="Modelo">
              <ModelInput value={v.llm_model} options={models(llmP, "llm")} onChange={(m) => patch({ llm_model: m })} id="llm-models" />
              <Btn onClick={() => setPicker("llm")}>Escolher com preços…</Btn>
            </Row>
            <Row label="Prazo">
              <select
                className="h-8 rounded border border-border bg-bg-term px-2 text-text-1"
                value={v.correct_timeout_sec || 30}
                onChange={(e) => patch({ correct_timeout_sec: Number(e.target.value) })}
              >
                {[10, 15, 20, 30, 45, 60, 90, 120].map((n) => (
                  <option key={n} value={n}>
                    {n} s{n === 30 ? " (padrão)" : ""}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-text-3">passou disso, usa o texto transcrito sem correção</span>
            </Row>
            <Toggle
              on={!!v.show_correction_stream}
              onClick={() => patch({ show_correction_stream: !v.show_correction_stream })}
              label="Mostrar a correção enquanto chega (senão aparece de uma vez, no fim)"
            />
          </>
        )}
        <div className="mt-2">
          <div className="mb-1 flex items-center gap-2 text-[12px] text-text-2">
            Prompt da correção <span className="text-text-3">— variáveis: {"{idioma}"}, {"{vocabulario}"}, {"{foneticos}"}</span>
            <div className="flex-1" />
            <button
              className="flex items-center gap-1 rounded bg-bg-hover px-2 py-0.5 text-text-1 hover:bg-border"
              onClick={() => {
                setPrompt(snap.default_prompt);
                patch({ prompt: snap.default_prompt });
              }}
            >
              <RotateCcw size={12} /> Restaurar padrão
            </button>
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onBlur={() => prompt !== v.prompt && patch({ prompt })}
            className="h-36 w-full resize-y rounded border border-border bg-bg-term p-2 text-[12px] text-text-1 outline-none focus:border-accent"
          />
        </div>
        <div className="mt-2">
          <div className="mb-1 flex items-center gap-2 text-[12px] text-text-2">
            Vocabulário do projeto <span className="text-text-3">— um termo por linha; vai no prompt e como dica na transcrição</span>
            <div className="flex-1" />
            {!vocab.trim() && (
              <button
                className="rounded bg-bg-hover px-2 py-0.5 text-text-1 hover:bg-border"
                onClick={() => {
                  setVocab(snap.default_vocabulary);
                  patch({ vocabulary: snap.default_vocabulary });
                }}
              >
                Sugerir termos
              </button>
            )}
          </div>
          <textarea
            value={vocab}
            onChange={(e) => setVocab(e.target.value)}
            onBlur={() => vocab !== v.vocabulary && patch({ vocabulary: vocab })}
            placeholder={"BethTerm\nWezTerm\nWSL\nPowerShell"}
            className="h-24 w-full resize-y rounded border border-border bg-bg-term p-2 font-mono text-[12px] text-text-1 outline-none focus:border-accent"
          />
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-text-2">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={v.tech_vocab !== false} onChange={(e) => patch({ tech_vocab: e.target.checked })} />
              Incluir vocabulário técnico padrão
            </label>
            <span className="text-text-3">(linguagens, IA, ferramentas, protocolos, termos em inglês — com a grafia correta)</span>
            <button className="rounded bg-bg-hover px-2 py-0.5 text-text-1 hover:bg-border" onClick={() => setShowTech(true)}>
              Ver lista
            </button>
          </div>
          {showTech && <TechVocabDialog conn={conn} onClose={() => setShowTech(false)} />}
        </div>
      </Section>

      <Section title="Envio ao agente">
        <Toggle
          on={v.prefix_enabled !== false}
          onClick={() => patch({ prefix_enabled: !(v.prefix_enabled !== false) })}
          label="Avisar o agente que o texto veio de voz"
        />
        {v.prefix_enabled !== false && (
          <div className="mt-2 flex items-start gap-2">
            <textarea
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              onBlur={() => prefix !== v.prefix_text && patch({ prefix_text: prefix })}
              className="h-16 flex-1 resize-y rounded border border-border bg-bg-term p-2 text-[12px] text-text-1 outline-none focus:border-accent"
            />
            <button
              className="flex items-center gap-1 rounded bg-bg-hover px-2 py-1 text-[12px] text-text-1 hover:bg-border"
              onClick={() => {
                setPrefix(snap.default_prefix);
                patch({ prefix_text: snap.default_prefix });
              }}
            >
              <RotateCcw size={12} /> Padrão
            </button>
          </div>
        )}
        <div className="mt-2">
          <Toggle
            on={v.send_direct}
            onClick={() => patch({ send_direct: !v.send_direct })}
            label="Enviar direto ao terminal, sem revisar (o Enter continua sendo seu)"
          />
        </div>
        <p className="mt-2 text-[11px] text-text-3">
          O texto é colado no terminal sem Enter no final: você revisa no próprio agente e aperta Enter. Quebras de linha não viram Enter.
        </p>
      </Section>
    </div>
  );
}

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function providerHay(p: ProviderView): string {
  return fold(
    [p.name, p.id, p.notes, p.kind, ...(p.stt_models ?? []), ...(p.llm_models ?? []), p.login === "device" ? "conta codigo" : ""]
      .filter(Boolean)
      .join(" "),
  );
}

function ProvidersTab({
  conn,
  snap,
  v,
  save,
  apply,
  setMsg,
}: {
  conn: Connection;
  snap: VoiceSnapshot;
  v: VoiceSettings;
  save: (v: VoiceSettings) => void;
  apply: (s: VoiceSnapshot) => void;
  setMsg: (m: string) => void;
}) {
  const [q, setQ] = useState("");
  const needle = fold(q.trim());
  const list = needle ? snap.providers.filter((p) => providerHay(p).includes(needle)) : snap.providers;
  return (
    <div className="space-y-2">
      <div className="sticky top-0 z-10 -mx-4 bg-bg-card px-4 pb-2">
        <div className="flex items-center gap-1.5 rounded border border-border bg-bg-term px-2">
          <Search size={14} className="shrink-0 text-text-3" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar provedor…"
            className="h-8 min-w-0 flex-1 bg-transparent text-[13px] text-text-1 outline-none placeholder:text-text-3"
          />
          {q && (
            <button className="text-text-3 hover:text-text-1" title="Limpar busca" onClick={() => setQ("")}>
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      <p className="text-[12px] text-text-2">
        As chaves ficam cifradas neste computador (DPAPI do Windows) e nunca voltam para a tela. Todas as chamadas aos provedores são feitas pelo
        bethterm-web. Uma chave serve para transcrição e correção no mesmo provedor.
      </p>
      {list.length === 0 ? (
        <p className="text-[12px] text-text-3">Nenhum provedor com “{q.trim()}”.</p>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          {list.map((p) => (
            <ProviderCard key={p.id} conn={conn} p={p} v={v} save={save} apply={apply} setMsg={setMsg} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderCard({
  conn,
  p,
  v,
  save,
  apply,
  setMsg,
}: {
  conn: Connection;
  p: ProviderView;
  v: VoiceSettings;
  save: (v: VoiceSettings) => void;
  apply: (s: VoiceSnapshot) => void;
  setMsg: (m: string) => void;
}) {
  const [editKey, setEditKey] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const prefs = v.providers?.[p.id] ?? {};
  const [base, setBase] = useState(prefs.base_url ?? "");
  const [audio, setAudio] = useState(prefs.audio_url ?? "");
  const [apiVer, setApiVer] = useState(prefs.api_version ?? "");
  const [pick, setPick] = useState(false);
  const savePrefs = (np: Partial<typeof prefs>) => save({ ...v, providers: { ...(v.providers ?? {}), [p.id]: { ...prefs, ...np } } });
  const run = async (label: string, f: () => Promise<string>) => {
    setBusy(label);
    setResult(null);
    try {
      setResult({ ok: true, text: await f() });
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-md border border-border bg-bg-panel p-3">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded bg-bg-hover text-text-2">{p.local ? <Server size={14} /> : <KeyRound size={14} />}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-text-1">{p.name}</div>
          <div className="text-[11px] text-text-3">
            {[p.stt && "transcrição", p.llm && "correção"].filter(Boolean).join(" · ")}
            {p.local && " · local, sem chave"}
          </div>
        </div>
        {p.configured ? (
          <span className="flex items-center gap-1 text-[11px] text-status-ok" title={p.key_source?.startsWith("env:") ? `chave da variável ${p.key_source.slice(4)}` : undefined}>
            <Check size={12} /> {p.login === "device" ? "conta ligada" : p.needs_key ? p.masked : "pronto"}
          </span>
        ) : (
          <span className="text-[11px] text-text-3">{p.login === "device" ? "sem conta" : "sem chave"}</span>
        )}
      </div>
      {p.notes && <div className="mt-1 text-[11px] text-text-3">{p.notes}</div>}

      {p.login === "device" && (
        <AccountLogin
          conn={conn}
          provider={p.id}
          name={p.name}
          configured={p.configured}
          onSnapshot={(s) => {
            apply(s);
            setMsg(`Conta ${p.name} ligada`);
          }}
          onLogout={(s) => {
            apply(s);
            setMsg(`Conta ${p.name} desligada`);
          }}
          onError={(m) => setMsg(`Erro: ${m}`)}
        />
      )}

      {p.needs_key && p.login !== "device" && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {editKey || !p.configured ? (
            <>
              <input
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="Cole a chave de API"
                className="h-7 min-w-0 flex-1 rounded border border-border bg-bg-term px-2 text-[12px] text-text-1 outline-none focus:border-accent"
              />
              <Btn
                disabled={!key.trim()}
                onClick={() =>
                  void saveKey(conn, p.id, key)
                    .then((s) => {
                      apply(s);
                      setKey("");
                      setEditKey(false);
                      setMsg(`Chave de ${p.name} salva`);
                    })
                    .catch((e: Error) => setMsg(`Erro: ${e.message}`))
                }
              >
                Salvar
              </Btn>
              {p.configured && <Btn onClick={() => setEditKey(false)}>Cancelar</Btn>}
            </>
          ) : (
            <>
              <Btn onClick={() => setEditKey(true)}>Trocar chave</Btn>
              {p.key_source === "salva" && (
                <Btn
                  onClick={() =>
                    void saveKey(conn, p.id, "")
                      .then(apply)
                      .catch((e: Error) => setMsg(`Erro: ${e.message}`))
                  }
                >
                  Apagar chave
                </Btn>
              )}
            </>
          )}
          {p.keys_url && (
            <button
              className="flex items-center gap-1 text-[11px] text-accent-text hover:underline"
              onClick={() => void openKeysPage(conn, p.id).catch((e: Error) => setMsg(`Erro: ${e.message}`))}
              title={p.keys_url}
            >
              <ExternalLink size={11} /> Onde pego minha chave?
            </button>
          )}
        </div>
      )}

      {(p.edit_url || p.kind === "azure") && (
        <div className="mt-2 space-y-1">
          <input
            value={base}
            onChange={(e) => setBase(e.target.value)}
            onBlur={() => base !== (prefs.base_url ?? "") && savePrefs({ base_url: base.trim() })}
            placeholder={p.kind === "azure" ? "https://<recurso>.openai.azure.com" : p.base_url || "URL base compatível com OpenAI (…/v1)"}
            className="h-7 w-full rounded border border-border bg-bg-term px-2 font-mono text-[11px] text-text-1 outline-none focus:border-accent"
          />
          {p.audio_url !== undefined && p.audio_url !== "" && (
            <input
              value={audio}
              onChange={(e) => setAudio(e.target.value)}
              onBlur={() => audio !== (prefs.audio_url ?? "") && savePrefs({ audio_url: audio.trim() })}
              placeholder={`URL do áudio (${p.audio_url})`}
              className="h-7 w-full rounded border border-border bg-bg-term px-2 font-mono text-[11px] text-text-1 outline-none focus:border-accent"
            />
          )}
          {p.kind === "azure" && (
            <input
              value={apiVer}
              onChange={(e) => setApiVer(e.target.value)}
              onBlur={() => apiVer !== (prefs.api_version ?? "") && savePrefs({ api_version: apiVer.trim() })}
              placeholder="api-version (ex. 2024-10-21)"
              className="h-7 w-full rounded border border-border bg-bg-term px-2 font-mono text-[11px] text-text-1 outline-none focus:border-accent"
            />
          )}
        </div>
      )}

      {pick && (
        <ModelPicker
          conn={conn}
          provider={p.id}
          providerName={p.name}
          func={p.stt && p.llm ? "all" : p.stt ? "stt" : "llm"}
          canSTT={p.stt}
          canLLM={p.llm}
          recommended={recommendedOf(p)}
          current={{ stt: v.stt_provider === p.id ? v.stt_model : undefined, llm: v.llm_provider === p.id ? v.llm_model : undefined }}
          onPick={(f, id) => {
            save(f === "stt" ? { ...v, stt_provider: p.id, stt_model: id } : { ...v, llm_provider: p.id, llm_model: id, llm_enabled: true });
            setMsg(`${f === "stt" ? "Transcrição" : "Correção"}: ${p.name} · ${id}`);
            setPick(false);
          }}
          onClose={() => setPick(false)}
        />
      )}
      {p.id === "deepinfra" && (
        <label className="mt-2 flex items-center gap-2 text-[11px] text-text-2">
          Rota da transcrição
          <select
            className="h-7 rounded border border-border bg-bg-term px-1 text-[12px] text-text-1"
            value={prefs.route === "openai" ? "openai" : "native"}
            onChange={(e) => savePrefs({ route: e.target.value === "openai" ? "openai" : "" })}
          >
            <option value="native">Nativa (/v1/inference/&lt;modelo&gt;) — padrão</option>
            <option value="openai">OpenAI-compatível (/v1/openai/audio/transcriptions)</option>
          </select>
          <span className="text-text-3">compare em Voz e IA → Comparar caminhos</span>
        </label>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {(p.stt || p.llm) && <Btn onClick={() => setPick(true)}>Ver modelos e preços…</Btn>}
        <Btn disabled={!!busy || (p.needs_key && !p.configured)} onClick={() => void run("test", async () => (await testProvider(conn, p.id)).message)}>
          {busy === "test" ? <Loader2 size={12} className="animate-spin" /> : null} Testar
        </Btn>
        {p.models_list && (
          <Btn
            disabled={!!busy || (p.needs_key && !p.configured)}
            onClick={() =>
              void run("models", async () => {
                const r = await fetchModels(conn, p.id);
                setModels(r.models);
                return `${r.models.length} modelos`;
              })
            }
          >
            {busy === "models" ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />} Buscar modelos
          </Btn>
        )}
        {result && <span className={cn("text-[11px]", result.ok ? "text-status-ok" : "text-status-err")}>{result.text}</span>}
      </div>
      {models && models.length > 0 && (
        <div className="mt-1 max-h-32 overflow-y-auto rounded border border-border bg-bg-term p-1 font-mono text-[11px] text-text-2">
          {models.map((m) => (
            <div key={m} className="flex items-center gap-1 px-1 hover:bg-bg-hover">
              <span className="min-w-0 flex-1 truncate">{m}</span>
              {p.stt && (
                <button className="text-accent-text hover:underline" onClick={() => savePrefs({ stt_models: [...new Set([...(prefs.stt_models ?? p.stt_models ?? []), m])] })}>
                  + transcrição
                </button>
              )}
              {p.llm && (
                <button className="text-accent-text hover:underline" onClick={() => savePrefs({ llm_models: [...new Set([...(prefs.llm_models ?? p.llm_models ?? []), m])] })}>
                  + correção
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- pecas -------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-text-2">{title}</div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-text-2">{label}</span>
      {children}
    </div>
  );
}

function ProviderSelect({ list, value, onChange }: { list: ProviderView[]; value: string; onChange: (id: string) => void }) {
  return (
    <select className="h-8 min-w-0 flex-1 rounded border border-border bg-bg-term px-2 text-text-1" value={value} onChange={(e) => onChange(e.target.value)}>
      {list.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
          {p.configured ? "" : " (sem chave)"}
        </option>
      ))}
    </select>
  );
}

function KeyStatus({ p, onGo }: { p: ProviderView | undefined; onGo: () => void }) {
  if (!p) return null;
  return p.configured ? (
    <span className="flex shrink-0 items-center gap-1 text-[11px] text-status-ok">
      <Check size={12} /> {p.needs_key ? p.masked : "pronto"}
    </span>
  ) : (
    <button className="shrink-0 text-[11px] text-status-warn hover:underline" onClick={onGo}>
      cadastrar chave…
    </button>
  );
}

function ModelInput({ value, options, onChange, id }: { value: string; options: string[]; onChange: (m: string) => void; id: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <>
      <input
        list={id}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== value && onChange(text.trim())}
        className="h-8 min-w-0 flex-1 rounded border border-border bg-bg-term px-2 font-mono text-[12px] text-text-1 outline-none focus:border-accent"
      />
      <datalist id={id}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      <div className="flex shrink-0 flex-wrap gap-1">
        {options.slice(0, 3).map((o) => (
          <button
            key={o}
            className={cn("rounded px-1.5 py-0.5 text-[10px]", o === value ? "bg-accent text-white" : "bg-bg-hover text-text-2 hover:text-text-1")}
            onClick={() => onChange(o)}
            title={o}
          >
            {o.split("/").pop()}
          </button>
        ))}
      </div>
    </>
  );
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button className="flex items-center gap-2 text-left text-[13px] text-text-1" onClick={onClick}>
      <span className={cn("relative h-4 w-7 shrink-0 rounded-full transition-colors", on ? "bg-accent" : "bg-border-strong")}>
        <span className={cn("absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all", on ? "left-3.5" : "left-0.5")} />
      </span>
      {label}
    </button>
  );
}

function AccountLogin({
  conn,
  provider,
  name,
  configured,
  onSnapshot,
  onLogout,
  onError,
}: {
  conn: Connection;
  provider: string;
  name: string;
  configured: boolean;
  onSnapshot: (s: VoiceSnapshot) => void;
  onLogout: (s: VoiceSnapshot) => void;
  onError: (m: string) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "wait" | "busy">("idle");
  const [code, setCode] = useState("");
  const [uri, setUri] = useState("");
  const [copied, setCopied] = useState(false);
  const stop = useRef(false);

  useEffect(() => {
    return () => {
      stop.current = true;
    };
  }, []);

  const start = async () => {
    stop.current = false;
    setCopied(false);
    setPhase("busy");
    try {
      const st = await startAccountLogin(conn, provider);
      if (stop.current) return;
      setCode(st.user_code);
      setUri(st.verification_uri);
      setPhase("wait");
      const gap = Math.max(1, st.interval) * 1000;
      while (!stop.current) {
        await new Promise((r) => setTimeout(r, gap));
        if (stop.current) return;
        const r = await pollAccountLogin(conn, provider);
        if (r.status === "pending") continue;
        onSnapshot(r);
        setPhase("idle");
        setCode("");
        return;
      }
    } catch (e) {
      if (!stop.current) {
        setPhase("idle");
        onError((e as Error).message);
      }
    }
  };

  return (
    <div className="mt-2 space-y-1.5">
      {phase === "wait" && code && (
        <div className="rounded border border-border bg-bg-term px-2 py-1.5">
          <div className="text-[11px] text-text-3">Digite este código em {name}</div>
          <div className="flex items-center gap-2">
            <div className="font-mono text-[18px] font-semibold tracking-widest text-text-1">{code}</div>
            <button
              className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-text-1 hover:bg-bg-hover"
              onClick={() =>
                void copyText(code).then((ok) => {
                  if (!ok) {
                    onError("não consegui copiar o código");
                    return;
                  }
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copiado" : "Copiar"}
            </button>
          </div>
          <button className="mt-1 flex items-center gap-1 text-[11px] text-accent-text hover:underline" onClick={() => void openExternal(conn, uri)}>
            <ExternalLink size={11} /> Abrir a página para autorizar
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {phase !== "wait" && (
          <Btn disabled={phase === "busy"} onClick={() => void start()}>
            {phase === "busy" ? <Loader2 size={12} className="animate-spin" /> : null}
            {configured ? "Entrar de novo" : "Entrar com código"}
          </Btn>
        )}
        {phase === "wait" && (
          <Btn
            onClick={() => {
              stop.current = true;
              setPhase("idle");
            }}
          >
            Cancelar
          </Btn>
        )}
        {configured && phase === "idle" && (
          <Btn
            onClick={() =>
              void logoutAccount(conn, provider)
                .then(onLogout)
                .catch((e: Error) => onError(e.message))
            }
          >
            Sair da conta
          </Btn>
        )}
      </div>
    </div>
  );
}

function Btn({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      className="flex items-center gap-1 rounded bg-bg-hover px-2 py-0.5 text-[12px] text-text-1 hover:bg-border disabled:opacity-40"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
