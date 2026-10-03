import { useEffect, useRef, useState } from "react";
import { Check, ClipboardCopy, FlaskConical, Loader2, Minus, X } from "lucide-react";
import type { Connection } from "@/lib/connection";
import { composeMessage, wordDiff, type VoiceSettings } from "@/lib/voice";
import { audioConstraints, micLog, pickMimeType, resolveMic, rmsLevel, type MicDevice } from "@/lib/mic";
import {
  VoiceError,
  comparePlan,
  fastestPath,
  correctStreaming,
  correctTimeoutMs,
  formatSeconds,
  formatUSD,
  markNoEnter,
  reportText,
  transcribe,
  type CompareRow,
  type PipelineStep,
} from "@/lib/voicePipeline";
import { copyText } from "@/lib/clipboard";
import { LevelBar } from "./MicPicker";
import { cn } from "@/lib/utils";

const RECORD_MS = 5000;

/** Grava `ms` do microfone escolhido (com nivel ao vivo). */
async function recordFor(ms: number, v: VoiceSettings, onLevel: (l: number) => void, signal: AbortSignal) {
  let deviceId = "";
  if (v.mic_device_id) deviceId = resolveMic((await navigator.mediaDevices.enumerateDevices()) as MicDevice[], { id: v.mic_device_id, label: v.mic_label ?? "" }).deviceId;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(deviceId) });
  const track = stream.getAudioTracks()[0];
  const ac = new AudioContext();
  try {
    const an = ac.createAnalyser();
    an.fftSize = 1024;
    ac.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const mime = pickMimeType((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    let peak = 0;
    const done = new Promise<void>((res) => (rec.onstop = () => res()));
    rec.start(250);
    const t0 = performance.now();
    await new Promise<void>((res, rej) => {
      const tick = () => {
        if (signal.aborted) return rej(new VoiceError("cancelado", { canceled: true }));
        an.getByteTimeDomainData(buf);
        const l = rmsLevel(buf);
        peak = Math.max(peak, l);
        onLevel(l);
        if (performance.now() - t0 >= ms) res();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }).finally(() => rec.state === "recording" && rec.stop());
    await done;
    return { blob: new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" }), micName: track?.label || "microfone padrão", peak, mime };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    void ac.close().catch(() => undefined);
    onLevel(0);
  }
}

/** Regrava o WAV de exemplo em webm/opus (tempo real, sem tocar nos alto-falantes). */
async function wavToWebm(wav: Blob, signal: AbortSignal): Promise<Blob> {
  const ac = new AudioContext();
  try {
    const buf = await ac.decodeAudioData(await wav.arrayBuffer());
    const dest = ac.createMediaStreamDestination();
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(dest);
    const mime = pickMimeType((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(dest.stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise<void>((res) => (rec.onstop = () => res()));
    rec.start(250);
    src.start();
    await new Promise<void>((res, rej) => {
      src.onended = () => res();
      signal.addEventListener("abort", () => rej(new VoiceError("cancelado", { canceled: true })));
    }).finally(() => rec.state === "recording" && rec.stop());
    await done;
    return new Blob(chunks, { type: rec.mimeType || "audio/webm" });
  } finally {
    void ac.close().catch(() => undefined);
  }
}

/** "Testar tudo": microfone (ou audio de exemplo) → transcricao → correcao → texto final, sem enviar ao terminal. */
export function PipelineTest({ conn, v, providerName }: { conn: Connection; v: VoiceSettings; providerName: (id: string) => string }) {
  const [useSample, setUseSample] = useState(false);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<PipelineStep[]>([]);
  const [level, setLevel] = useState(0);
  const [diff, setDiff] = useState<{ a: string; b: string } | null>(null);
  const [finalMsg, setFinalMsg] = useState<string | null>(null);
  const [when, setWhen] = useState(new Date());
  const [copied, setCopied] = useState(false);
  const acRef = useRef<AbortController | null>(null);
  useEffect(() => () => acRef.current?.abort(), []);
  const [cmp, setCmp] = useState<CompareRow[] | null>(null);
  const [cmpNote, setCmpNote] = useState("");

  /** "Comparar caminhos": o MESMO audio de exemplo por cada rota/formato, 2 rodadas. */
  const compare = async () => {
    const ac = new AbortController();
    acRef.current = ac;
    setRunning(true);
    setSteps([]);
    const plan = comparePlan(v.stt_provider);
    setCmp(plan);
    setCmpNote("preparando o áudio (WAV e webm)…");
    micLog(conn, `comparar caminhos: início (${plan.length} envios)`);
    try {
      const r = await conn.getBlob("/api/voice/sample", ac.signal);
      const audioMs = Number(r.headers.get("X-Audio-Ms")) || 4000;
      const wav = r.blob;
      const webm = await wavToWebm(wav, ac.signal);
      setCmpNote(`áudio: WAV ${(wav.size / 1024).toFixed(0)} KB · webm ${(webm.size / 1024).toFixed(0)} KB · ${formatSeconds(audioMs)}`);
      for (let k = 0; k < plan.length; k++) {
        const row = plan[k];
        try {
          const tr = await transcribe(conn, row.format === "wav" ? wav : webm, { signal: ac.signal, audioMs, test: true, route: row.route });
          plan[k] = { ...row, ttfb_ms: tr.ttfb_ms, ms: tr.ms };
        } catch (e) {
          if ((e as VoiceError).canceled) throw e;
          plan[k] = { ...row, error: (e as Error).message };
        }
        setCmp([...plan]);
      }
      const best = fastestPath(plan);
      micLog(conn, `comparar caminhos: fim, melhor ${best ? `${best.route}/${best.format} ${Math.round(best.avgMs)} ms` : "nenhum"}`);
    } catch (e) {
      setCmpNote(`parou: ${(e as Error).message}`);
    } finally {
      setRunning(false);
      acRef.current = null;
    }
  };
  const best = cmp ? fastestPath(cmp) : null;

  const set = (i: number, p: Partial<PipelineStep>) => setSteps((ss) => ss.map((s, k) => (k === i ? { ...s, ...p, lines: p.lines ?? s.lines } : s)));

  const run = async () => {
    const ac = new AbortController();
    acRef.current = ac;
    setRunning(true);
    setDiff(null);
    setFinalMsg(null);
    setCopied(false);
    setWhen(new Date());
    const base: PipelineStep[] = [
      { title: useSample ? "Áudio de exemplo" : "Microfone (5 s)", status: "rodando", lines: [] },
      { title: `Envio + transcrição (${providerName(v.stt_provider)})`, status: "pendente", lines: [] },
      { title: `Correção (${v.llm_enabled ? providerName(v.llm_provider) : "desligada"})`, status: "pendente", lines: [] },
      { title: "Texto final (como seria colado)", status: "pendente", lines: [] },
      { title: "Custo estimado da rodada", status: "pendente", lines: [] },
    ];
    setSteps(base);
    setCmp(null);
    micLog(conn, `testar tudo: início (${useSample ? "áudio de exemplo" : "microfone"})`);
    let cost = 0;
    let costEst = false;
    let i = 0;
    try {
      // 1. audio
      let blob: Blob;
      let audioMs = RECORD_MS;
      const t1 = performance.now();
      if (useSample) {
        const r = await conn.getBlob("/api/voice/sample", ac.signal);
        blob = r.blob;
        audioMs = Number(r.headers.get("X-Audio-Ms")) || 4000;
        const dec = (h: string) => decodeURIComponent((r.headers.get(h) ?? "").replace(/\+/g, " "));
        const lines = [`frase: “${dec("X-Sample-Text")}”`, `voz: ${dec("X-Sample-Voice")}`, `${(blob.size / 1024).toFixed(0)} KB, ${formatSeconds(audioMs)} (WAV)`];
        if (dec("X-Sample-Warning")) lines.push(`aviso: ${dec("X-Sample-Warning")}`);
        set(0, { status: "ok", ms: performance.now() - t1, lines });
      } else {
        const r = await recordFor(RECORD_MS, v, setLevel, ac.signal);
        blob = r.blob;
        const lines = [`${r.micName}`, `${(blob.size / 1024).toFixed(0)} KB (${r.mime || "formato padrão"}), pico de nível ${Math.round(r.peak * 100)}%`];
        if (r.peak < 0.02) lines.push("nenhum som captado — o microfone está mudo ou é o microfone errado?");
        if (blob.size < 100) throw Object.assign(new Error("o gravador não entregou áudio"), { step: 0 });
        set(0, { status: r.peak < 0.02 ? "erro" : "ok", ms: performance.now() - t1, lines });
      }
      // 2. transcricao
      i = 1;
      set(1, { status: "rodando" });
      const tr = await transcribe(conn, blob, { signal: ac.signal, audioMs, test: true });
      cost += tr.cost_usd || 0;
      costEst ||= tr.cost_estimated;
      set(1, {
        status: tr.text.trim() ? "ok" : "erro",
        ms: tr.ms,
        lines: [
          `${tr.model} · ${(tr.bytes / 1024).toFixed(0)} KB, ${formatSeconds(tr.audio_sec * 1000)} de áudio`,
          `1º byte em ${formatSeconds(tr.ttfb_ms)} · total ${formatSeconds(tr.ms)}${tr.ms > 8000 ? " (lento — o Groq costuma responder em ~1 s, só informativo)" : ""}`,
          tr.text.trim() ? `texto: “${tr.text}”` : "o provedor não reconheceu fala no áudio",
        ],
      });
      // 3. correcao
      i = 2;
      let final = tr.text;
      if (v.llm_enabled && tr.text.trim()) {
        set(2, { status: "rodando" });
        try {
          const c = await correctStreaming(conn, tr.text, { signal: ac.signal, timeoutMs: correctTimeoutMs(v.correct_timeout_sec), test: true });
          cost += c.cost_usd || 0;
          costEst ||= c.cost_estimated;
          final = c.text;
          setDiff({ a: tr.text, b: c.text });
          set(2, {
            status: "ok",
            ms: c.ms,
            lines: [
              `${c.model} · 1º trecho em ${formatSeconds(c.ttfb_ms)} · total ${formatSeconds(c.ms)} · tokens ${c.in_tokens}/${c.out_tokens}`,
              `antes: “${tr.text}”`,
              `depois: “${c.text}”`,
            ],
          });
        } catch (e) {
          const ve = e as VoiceError;
          if (ve.canceled) throw e;
          set(2, { status: "erro", lines: [ve.timeout ? `A correção demorou demais (${ve.message}) — seria usado o texto original` : ve.message] });
        }
      } else set(2, { status: "pulado", lines: [v.llm_enabled ? "sem texto para corrigir" : "correção desligada"] });
      // 4. texto final
      i = 3;
      const msg = composeMessage(v.prefix_enabled !== false, v.prefix_text, final);
      setFinalMsg(msg);
      set(3, { status: msg.trim() ? "ok" : "erro", lines: markNoEnter(msg).split("\n") });
      // 5. custo
      i = 4;
      set(4, { status: "ok", lines: [`${formatUSD(cost)}${costEst ? " (estimado)" : ""} — registrado em Uso e custos de IA como teste`] });
      micLog(conn, `testar tudo: fim, custo ${cost}`);
    } catch (e) {
      const ve = e as VoiceError;
      const name = (e as DOMException).name;
      const msg = ve.canceled || name === "AbortError" ? "cancelado" : name === "NotAllowedError" || name === "NotFoundError" ? `microfone: ${name}` : ve.message;
      micLog(conn, `testar tudo: parou na etapa ${i + 1}: ${msg}`);
      setSteps((ss) => ss.map((s, k) => (k === i ? { ...s, status: "erro", lines: [...s.lines, msg] } : k > i ? { ...s, status: "pulado" } : s)));
    } finally {
      setRunning(false);
      acRef.current = null;
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
          disabled={running}
          onClick={() => void run()}
          title="Roda o caminho inteiro sem enviar nada ao terminal (gasta alguns centavos)"
        >
          {running ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />} Testar tudo
        </button>
        <button
          className="rounded bg-bg-hover px-3 py-1.5 text-[12px] text-text-1 hover:bg-border disabled:opacity-50"
          disabled={running}
          onClick={() => void compare()}
          title="Envia o mesmo áudio de exemplo por cada caminho (formato e rota), 2 rodadas, e mostra os tempos (gasta alguns centavos)"
        >
          Comparar caminhos
        </button>
        <label className="flex items-center gap-1.5 text-[12px] text-text-2">
          <input type="checkbox" checked={useSample} disabled={running} onChange={(e) => setUseSample(e.target.checked)} />
          usar áudio de exemplo (sem falar)
        </label>
        {running && (
          <button className="rounded bg-bg-hover px-3 py-1 text-[12px] text-text-1 hover:bg-border" onClick={() => acRef.current?.abort()}>
            Cancelar
          </button>
        )}
        {!running && steps.length > 0 && (
          <button
            className="flex items-center gap-1 rounded bg-bg-hover px-2.5 py-1 text-[12px] text-text-1 hover:bg-border"
            onClick={() => void copyText(reportText(steps, when)).then(setCopied)}
          >
            <ClipboardCopy size={12} /> {copied ? "Copiado" : "Copiar relatório"}
          </button>
        )}
      </div>
      {running && steps[0]?.status === "rodando" && !useSample && (
        <div className="flex items-center gap-2 text-[12px] text-text-2">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-[#DC2626]" /> gravando 5 s — fale algo
          <LevelBar level={level} className="w-48" />
        </div>
      )}
      {cmp && steps.length === 0 && (
        <div className="rounded border border-border bg-bg-panel p-2 text-[12px]">
          <div className="mb-1 text-text-2">{cmpNote}</div>
          <table className="w-full">
            <thead className="text-[11px] text-text-3">
              <tr>
                <th className="text-left font-normal">rodada</th>
                <th className="text-left font-normal">rota</th>
                <th className="text-left font-normal">formato</th>
                <th className="text-right font-normal">1º byte</th>
                <th className="text-right font-normal">total</th>
              </tr>
            </thead>
            <tbody>
              {cmp.map((r, k) => (
                <tr key={k} className={cn(best && r.route === best.route && r.format === best.format && "text-status-ok")}>
                  <td>{r.round}</td>
                  <td>{r.route === "native" ? "nativa (inference)" : "OpenAI-compatível"}</td>
                  <td>{r.format}</td>
                  <td className="text-right tabular-nums">{r.ttfb_ms !== undefined ? formatSeconds(r.ttfb_ms) : ""}</td>
                  <td className="text-right tabular-nums">
                    {r.error ? <span className="text-status-err">{r.error}</span> : r.ms !== undefined ? formatSeconds(r.ms) : running ? "…" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {best && !running && (
            <div className="mt-1 text-text-2">
              Mais rápido em média: {best.route === "native" ? "rota nativa" : "rota OpenAI-compatível"} com {best.format} ({formatSeconds(best.avgMs)}).
              {v.stt_provider === "deepinfra" && " A rota fica em Provedores de IA → DeepInfra."}
            </div>
          )}
        </div>
      )}
      {steps.length > 0 && (
        <ol className="space-y-1.5 rounded border border-border bg-bg-panel p-2 text-[12px]">
          {steps.map((s, k) => (
            <li key={k}>
              <div className="flex items-center gap-1.5">
                <StepIcon status={s.status} />
                <span className="font-semibold text-text-1">
                  {k + 1}. {s.title}
                </span>
                {s.ms !== undefined && <span className="text-text-3">{formatSeconds(s.ms)}</span>}
              </div>
              {k === 2 && diff && diff.a !== diff.b ? (
                <div className="ml-6 text-text-2">
                  <div>{s.lines[0]}</div>
                  <div className="mt-0.5 leading-relaxed">
                    {wordDiff(diff.a, diff.b).map((d, j) => (
                      <span
                        key={j}
                        className={cn(d.kind === "added" && "rounded-sm bg-status-ok/20 text-text-1", d.kind === "removed" && "text-text-3 line-through")}
                      >
                        {d.text}
                      </span>
                    ))}
                  </div>
                </div>
              ) : k === 3 && finalMsg !== null ? (
                <pre className="ml-6 mt-0.5 whitespace-pre-wrap break-words rounded bg-bg-term p-1.5 font-mono text-[11px] text-text-1">{markNoEnter(finalMsg)}</pre>
              ) : (
                s.lines.map((l, j) => (
                  <div key={j} className="ml-6 break-words text-text-2">
                    {l}
                  </div>
                ))
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function StepIcon({ status }: { status: PipelineStep["status"] }) {
  if (status === "ok") return <Check size={14} className="text-status-ok" />;
  if (status === "erro") return <X size={14} className="text-status-err" />;
  if (status === "rodando") return <Loader2 size={14} className="animate-spin text-accent-text" />;
  return <Minus size={14} className="text-text-3" />;
}
