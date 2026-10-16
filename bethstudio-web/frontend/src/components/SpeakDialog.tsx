import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { Loader2, Mic, Settings2, Square, X } from "lucide-react";
import type { Connection } from "@/lib/connection";
import type { PaneInfo } from "@/lib/types";
import { paneLabel } from "@/lib/panes";
import { loadPref, savePref } from "@/lib/filePreview";
import { SPEAK_POS_KEY, initialPos, isPos, keepInside, type Pos } from "@/lib/speakPos";
import {
  MAX_RECORD_MS,
  composeMessage,
  formatDuration,
  loadVoice,
  micErrorMessage,
  saveVoice,
  wordDiff,
  type VoiceSnapshot,
} from "@/lib/voice";
import { SilenceWatch, audioConstraints, blobProblem, micLog, pickMimeType, resolveMic, rmsLevel, type MicChoice, type MicDevice } from "@/lib/mic";
import { LevelBar, MicPicker } from "./MicPicker";
import { VoiceError, correctStreaming, correctTimeoutMs, errorRecovery, formatSeconds, formatUSD, transcribe, type VoiceErrorKind } from "@/lib/voicePipeline";
import type { SettingsSection } from "./SettingsDialog";
import { cn } from "@/lib/utils";

type Phase = "loading" | "privacy" | "recording" | "transcribing" | "correcting" | "review" | "error";

interface Props {
  conn: Connection;
  pane: number;
  info: PaneInfo | undefined;
  onClose: () => void;
  /** abre Configuracoes; secao "provedores" quando o erro e' de chave */
  onOpenSettings: (section?: SettingsSection) => void;
  onSent: (msg: string) => void;
}

/**
 * Popup "Falar": grava, transcreve (e corrige, se ligado), mostra para
 * revisar e cola no terminal com `paste` SEM Enter final.
 *
 * A gravacao comeca UMA vez ao abrir. Os callbacks do App mudam a cada
 * render (a tela atualiza o tempo todo): ficam em refs, para que isso nao
 * reinicie a gravacao — era o bug de "clico e nada chega": cada render
 * cancelava a gravacao e pedia o microfone de novo.
 *
 * A janela flutua, sem escurecer nem bloquear a tela, e se arrasta pelo
 * titulo: quem grava costuma estar lendo o que vai responder.
 */
export function SpeakDialog({ conn, pane, info, onClose, onOpenSettings, onSent }: Props) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [snap, setSnap] = useState<VoiceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<VoiceErrorKind>("");
  const lastAudio = useRef<{ blob: Blob; audioMs: number } | null>(null); // p/ "Tentar novamente" sem regravar
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [silent, setSilent] = useState(false);
  const [micName, setMicName] = useState("");
  const [mic, setMic] = useState<MicChoice>({ id: "", label: "" });
  const [original, setOriginal] = useState("");
  const [corrected, setCorrected] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [prefixOn, setPrefixOn] = useState(true);
  const [prefix, setPrefix] = useState("");
  const [info2, setInfo2] = useState("");
  const [workMs, setWorkMs] = useState(0); // tempo em "Transcrevendo…"/"Corrigindo…"
  const [streamText, setStreamText] = useState("");
  const [warn, setWarn] = useState<string | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  const [overLimit, setOverLimit] = useState<string | null>(null);
  const [manualRetry, setManualRetry] = useState(false); // "Corrigir novamente": so' a correção, sem regravar
  const work = useRef<AbortController | null>(null); // transcricao/correcao em andamento
  const skipCorrection = useRef(false);
  const recStart = useRef(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const acRef = useRef<AudioContext | null>(null);
  const discard = useRef(false); // o proximo onstop joga o audio fora
  const busy = useRef(false); // um getUserMedia/gravacao por vez
  const closed = useRef(false);
  const log = useCallback((m: string) => micLog(conn, m), [conn]);
  const propsRef = useRef({ onClose, onSent });
  propsRef.current = { onClose, onSent };

  // --- posição da janela (arrastar pelo título; lembra onde foi deixada) ------
  const boxRef = useRef<HTMLDivElement | null>(null);
  const posRef = useRef<Pos | null>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  /** Põe a janela no lugar certo (salvo, ou o padrão) e a mantém dentro da tela. */
  const place = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const next = posRef.current
      ? keepInside(posRef.current, r.width, r.height, vw, vh)
      : initialPos(loadPref<Pos | null>(SPEAK_POS_KEY, null, (v): v is Pos => isPos(v)), r.width, r.height, vw, vh);
    posRef.current = next;
    setPos(next);
  }, []);
  // a altura muda a cada fase (gravando, revisando…): reencaixa antes de pintar
  useLayoutEffect(place, [place, phase]);
  useEffect(() => {
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [place]);
  const startMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest("button")) return; // botões do título não arrastam
    const el = boxRef.current;
    const start = posRef.current;
    if (!el || !start) return;
    e.preventDefault();
    const { width, height } = el.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    const head = e.currentTarget;
    head.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const n = keepInside({ x: start.x + ev.clientX - sx, y: start.y + ev.clientY - sy }, width, height, window.innerWidth, window.innerHeight);
      posRef.current = n;
      setPos(n);
    };
    const up = () => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
      head.removeEventListener("pointercancel", up);
      if (posRef.current) savePref(SPEAK_POS_KEY, posRef.current);
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
    head.addEventListener("pointercancel", up);
  };

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void acRef.current?.close().catch(() => undefined);
    acRef.current = null;
  };

  const send = (body: string, pOn: boolean, p: string) => {
    const msg = composeMessage(pOn, p, body);
    if (!msg.trim()) return;
    conn.paste(pane, msg); // bracketed paste, sem Enter
    propsRef.current.onSent("Texto colado no terminal — revise e aperte Enter no agente");
    propsRef.current.onClose();
  };

  const process = async (blob: Blob, s: VoiceSnapshot, audioMs: number) => {
    const ac = new AbortController();
    work.current = ac;
    skipCorrection.current = false;
    setWarn(null);
    setErrorKind("");
    setStreamText("");
    setCost(null);
    const t0 = Date.now();
    setWorkMs(0);
    const clock = window.setInterval(() => setWorkMs(Date.now() - t0), 200);
    try {
      setPhase("transcribing");
      log(`envio: ${blob.size} bytes (${blob.type || "sem tipo"}), ${formatSeconds(audioMs)} de áudio, para ${s.settings.stt_provider}`);
      const tr = await transcribe(conn, blob, { signal: ac.signal, audioMs, pane });
      if (closed.current) return;
      log(`transcrição ok: ${tr.text.length} caracteres em ${tr.ms} ms (1º byte ${tr.ttfb_ms} ms)`);
      let spent = tr.cost_usd || 0;
      setOriginal(tr.text);
      setText(tr.text);
      let final = tr.text;
      let note = `Transcrito por ${tr.provider} em ${formatSeconds(tr.ms)} (1º byte em ${formatSeconds(tr.ttfb_ms)})`;
      if (!tr.text.trim()) note += " · o provedor não reconheceu fala no áudio";
      if (s.settings.llm_enabled && tr.text.trim() && !skipCorrection.current) {
        setPhase("correcting");
        const limit = correctTimeoutMs(s.settings.correct_timeout_sec);
        log(`correção início: ${s.settings.llm_provider} / ${s.settings.llm_model || "(padrão)"}, ${tr.text.length} caracteres, prazo ${limit / 1000} s`);
        try {
          // o streaming continua (1º trecho e prazo); o texto chegando so' aparece se o usuario pediu
          const c = await correctStreaming(conn, tr.text, {
            signal: ac.signal,
            timeoutMs: limit,
            pane,
            onDelta: s.settings.show_correction_stream ? setStreamText : undefined,
          });
          if (closed.current) return;
          if (!c.text.trim()) throw new VoiceError("a correção voltou vazia", { kind: "empty" });
          log(`correção ok em ${c.ms} ms (1º trecho ${c.ttfb_ms} ms), ${c.model}`);
          spent += c.cost_usd || 0;
          setCorrected(c.text);
          setText(c.text);
          final = c.text;
          note += ` · corrigido por ${c.model} em ${formatSeconds(c.ms)}`;
        } catch (e) {
          if (closed.current) return;
          const ve = e as VoiceError;
          if (ve.canceled) {
            log("correção pulada pelo usuário");
            note += " · correção pulada";
          } else if (ve.timeout) {
            log(`correção TIMEOUT: ${ve.message}`);
            setWarn("A correção demorou demais — usando o texto original");
          } else {
            log(`correção erro: ${ve.message}`);
            setWarn(`A correção falhou (${ve.message}) — usando o texto original`);
          }
        }
      }
      setCost(spent);
      setInfo2(note);
      const pOn = s.settings.prefix_enabled !== false;
      if (s.settings.send_direct && final.trim()) {
        send(final, pOn, s.settings.prefix_text);
        return;
      }
      setPhase("review");
    } catch (e) {
      if (closed.current) return;
      const ve = e as VoiceError;
      if (ve.canceled) {
        log("transcrição cancelada pelo usuário");
        propsRef.current.onClose();
        return;
      }
      log(`transcrição erro: ${ve.message}${ve.kind ? ` (${ve.kind})` : ""}`);
      setError(ve.message);
      setErrorKind(ve.kind);
      setPhase("error");
    } finally {
      window.clearInterval(clock);
      if (work.current === ac) work.current = null;
    }
  };

  const start = async (s: VoiceSnapshot, choice: MicChoice) => {
    if (busy.current || closed.current) {
      log("start ignorado: já há uma gravação em andamento");
      return;
    }
    busy.current = true;
    discard.current = false;
    setError(null);
    setSilent(false);
    setElapsed(0);
    setLevel(0);
    try {
      let deviceId = "";
      if (choice.id) {
        const r = resolveMic((await navigator.mediaDevices.enumerateDevices()) as MicDevice[], choice);
        deviceId = r.deviceId;
        if (!r.found) log(`microfone salvo "${choice.label}" não encontrado; usando o padrão`);
      }
      log(`getUserMedia (${deviceId ? `"${choice.label}"` : "padrão do Windows"})`);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(deviceId) });
      if (closed.current) {
        stream.getTracks().forEach((t) => t.stop());
        busy.current = false;
        return;
      }
      streamRef.current = stream;
      const track = stream.getAudioTracks()[0];
      const name = track?.label || choice.label || "microfone padrão";
      setMicName(name);
      log(`getUserMedia ok: "${name}" (enabled=${track?.enabled}, muted=${track?.muted}, estado=${track?.readyState})`);
      const mime = pickMimeType((m) => MediaRecorder.isTypeSupported(m));
      log(`MediaRecorder mimeType "${mime || "(padrão do navegador)"}"`);
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      let bytes = 0;
      rec.ondataavailable = (e) => {
        if (e.data.size) {
          chunks.push(e.data);
          bytes += e.data.size;
        }
        if (chunks.length <= 3 || chunks.length % 20 === 0) log(`dataavailable #${chunks.length}: ${e.data.size} bytes (total ${bytes})`);
      };
      rec.onerror = (e) => log(`MediaRecorder erro: ${(e as unknown as { error?: DOMException }).error?.name ?? "?"}`);
      rec.onstop = () => {
        stopTracks();
        recRef.current = null;
        busy.current = false;
        const blob = new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" });
        log(`stop: ${chunks.length} pedaços, blob ${blob.size} bytes${discard.current ? " (descartado)" : ""}`);
        if (discard.current || closed.current) return;
        const problem = blobProblem(blob.size, chunks.length);
        if (problem) {
          lastAudio.current = null; // audio inutilizavel: "Tentar novamente" nao ajudaria
          setError(problem);
          setErrorKind("");
          setPhase("error");
          return;
        }
        const audioMs = Date.now() - recStart.current;
        lastAudio.current = { blob, audioMs };
        void process(blob, s, audioMs);
      };
      recRef.current = rec;
      rec.start(250);
      recStart.current = Date.now();
      log(`start (estado ${rec.state})`);
      setPhase("recording");
      // nivel, tempo e aviso de silencio
      const ac = new AudioContext();
      acRef.current = ac;
      const an = ac.createAnalyser();
      an.fftSize = 1024;
      ac.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const watch = new SilenceWatch();
      const t0 = Date.now();
      let warned = false;
      const tick = () => {
        if (recRef.current !== rec || rec.state !== "recording") return;
        an.getByteTimeDomainData(buf);
        const l = rmsLevel(buf);
        setLevel(l);
        const now = Date.now();
        const quiet = watch.feed(l, now);
        setSilent(quiet);
        if (quiet && !warned) {
          warned = true;
          log("aviso: nenhum som captado por 3 s");
        }
        const el = now - t0;
        setElapsed(el);
        if (el >= MAX_RECORD_MS) rec.stop();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch (e) {
      busy.current = false;
      stopTracks();
      const name = (e as DOMException).name || "Error";
      log(`getUserMedia/MediaRecorder erro: ${name} ${(e as Error).message ?? ""}`);
      lastAudio.current = null;
      setError(`${micErrorMessage(name)} (${name})`);
      setErrorKind("");
      setPhase("error");
    }
  };

  // Uma vez so' ao abrir.
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    closed.current = false;
    loadVoice(conn)
      .then((s) => {
        if (closed.current) return;
        setSnap(s);
        setPrefixOn(s.settings.prefix_enabled !== false);
        setPrefix(s.settings.prefix_text);
        const choice = { id: s.settings.mic_device_id ?? "", label: s.settings.mic_label ?? "" };
        setMic(choice);
        if (!s.settings.privacy_ack) setPhase("privacy");
        else void startRef.current(s, choice);
      })
      .catch((e: Error) => {
        setError(e.message);
        setPhase("error");
      });
    // alerta de gasto mensal (so' avisa)
    conn
      .api<{ over_limit: boolean; limit_usd: number; month: { usd: number } }>("/api/ai-usage?recent=0")
      .then((u) => {
        if (u.over_limit && !closed.current)
          setOverLimit(`Gasto com IA neste mês: ${formatUSD(u.month.usd)} — passou do limite de ${formatUSD(u.limit_usd)} (só um aviso).`);
      })
      .catch(() => undefined);
    return () => {
      closed.current = true;
      work.current?.abort();
      discard.current = true;
      if (recRef.current?.state === "recording") recRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      busy.current = false;
    };
  }, [conn]);

  const stop = () => {
    if (recRef.current?.state === "recording") {
      log("parar (usuário)");
      recRef.current.stop();
    }
  };
  const cancel = () => {
    discard.current = true;
    work.current?.abort();
    stop();
    onClose();
  };
  /** "Tentar novamente": reenvia o MESMO audio ja' gravado, sem regravar. */
  const retry = () => {
    const a = lastAudio.current;
    if (!a || !snap) return;
    log("tentar novamente: reenviando o áudio já gravado");
    void process(a.blob, snap, a.audioMs);
  };
  /** Usa o texto transcrito ja' (cancela a correcao em andamento). */
  const skip = () => {
    skipCorrection.current = true;
    if (phase === "correcting") work.current?.abort();
  };
  /**
   * "Corrigir novamente": reenvia o texto JA' TRANSCRITO ao corretor, sem
   * regravar (diferente de "Gravar de novo", que descarta tudo). Disponivel
   * sempre que a correção estiver ligada — depois de uma correção ruim/vazia
   * ou so' porque o usuário quer tentar de novo.
   */
  const retryCorrection = () => {
    if (!snap || !original.trim() || work.current) return;
    const ac = new AbortController();
    work.current = ac;
    setManualRetry(true);
    setWarn(null);
    setStreamText("");
    const t0 = Date.now();
    setWorkMs(0);
    const clock = window.setInterval(() => setWorkMs(Date.now() - t0), 200);
    setPhase("correcting");
    const limit = correctTimeoutMs(snap.settings.correct_timeout_sec);
    log(`corrigir novamente: ${snap.settings.llm_provider} / ${snap.settings.llm_model || "(padrão)"}, ${original.length} caracteres, prazo ${limit / 1000} s`);
    correctStreaming(conn, original, {
      signal: ac.signal,
      timeoutMs: limit,
      pane,
      onDelta: snap.settings.show_correction_stream ? setStreamText : undefined,
    })
      .then((c) => {
        if (closed.current) return;
        if (!c.text.trim()) throw new VoiceError("a correção voltou vazia", { kind: "empty" });
        log(`corrigir novamente: ok em ${c.ms} ms (1º trecho ${c.ttfb_ms} ms), ${c.model}`);
        setCorrected(c.text);
        setText(c.text);
        setCost((v) => (v ?? 0) + (c.cost_usd || 0));
        setInfo2((prev) => `${prev} · corrigido de novo por ${c.model} em ${formatSeconds(c.ms)}`);
      })
      .catch((e) => {
        if (closed.current) return;
        const ve = e as VoiceError;
        if (ve.canceled) log("corrigir novamente: cancelado pelo usuário");
        else if (ve.timeout) {
          log(`corrigir novamente: TIMEOUT: ${ve.message}`);
          setWarn("A correção demorou demais — mantendo o texto anterior");
        } else {
          log(`corrigir novamente: erro: ${ve.message}`);
          setWarn(`A correção falhou (${ve.message}) — mantendo o texto anterior`);
        }
      })
      .finally(() => {
        window.clearInterval(clock);
        if (work.current === ac) work.current = null;
        setManualRetry(false);
        if (!closed.current) setPhase("review");
      });
  };
  /** Cancela so' o "Corrigir novamente" (volta a revisar, sem fechar o popup). */
  const cancelManualRetry = () => {
    work.current?.abort();
  };
  /** Troca de microfone: salva e, se estiver gravando, recomeça com o novo. */
  const changeMic = (c: MicChoice) => {
    setMic(c);
    log(`microfone escolhido: ${c.id ? `"${c.label}"` : "padrão do Windows"}`);
    if (!snap) return;
    const next = { ...snap.settings, mic_device_id: c.id, mic_label: c.label };
    const s2 = { ...snap, settings: next };
    setSnap(s2);
    void saveVoice(conn, next).catch(() => undefined);
    const rec = recRef.current;
    if (rec?.state === "recording") {
      discard.current = true;
      const prev = rec.onstop;
      rec.onstop = (ev) => {
        prev?.call(rec, ev);
        void startRef.current(s2, c);
      };
      rec.stop();
    }
  };

  const sttName = snap?.providers.find((p) => p.id === snap.settings.stt_provider)?.name ?? "";
  const llmName = snap?.settings.llm_enabled ? snap?.providers.find((p) => p.id === snap.settings.llm_provider)?.name : undefined;

  return (
    <div className="pointer-events-none fixed inset-0 z-[60]">
      <div
        ref={boxRef}
        style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? "visible" : "hidden" }}
        className="pointer-events-auto absolute flex max-h-[84vh] w-[min(640px,94vw)] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-card shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") cancel();
          if (e.key === "Enter" && e.ctrlKey && phase === "review") send(text, prefixOn, prefix);
        }}
      >
        <div
          className="flex cursor-move touch-none select-none items-center gap-2 border-b border-border px-4 py-2.5"
          onPointerDown={startMove}
          title="Arraste para mover a janela"
        >
          <Mic size={16} className="text-accent-text" />
          <div className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text-1">Falar para {info ? paneLabel(info) : `terminal ${pane}`}</div>
          <button className="rounded p-1 text-text-2 hover:bg-bg-hover hover:text-text-1" title="Configurar voz e provedores" onClick={() => onOpenSettings()}>
            <Settings2 size={15} />
          </button>
          <button className="rounded p-1 text-text-2 hover:bg-bg-hover hover:text-text-1" title="Cancelar" onClick={cancel}>
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {phase === "loading" && <Busy text="Preparando…" />}
          {phase === "privacy" && snap && (
            <div className="space-y-3">
              <p className="text-text-1">
                O áudio gravado vai para <b>{sttName}</b>
                {llmName ? (
                  <>
                    {" "}
                    e o texto para <b>{llmName}</b>
                  </>
                ) : null}{" "}
                para ser transcrito. Nada é enviado ao terminal sem você ver (a não ser que ligue “enviar direto”).
              </p>
              <div className="flex gap-2">
                <button
                  className="rounded bg-accent px-3 py-1.5 text-white hover:bg-accent-hover"
                  onClick={() => {
                    const next = { ...snap.settings, privacy_ack: true };
                    void saveVoice(conn, next).catch(() => undefined);
                    void start({ ...snap, settings: next }, mic);
                  }}
                >
                  Entendi, gravar
                </button>
                <button className="rounded bg-bg-hover px-3 py-1.5 text-text-1 hover:bg-border" onClick={() => onOpenSettings()}>
                  Escolher provedor
                </button>
              </div>
            </div>
          )}
          {(phase === "privacy" || phase === "error" || phase === "recording") && snap && (
            <div className="rounded border border-border bg-bg-panel p-2">
              <div className="mb-1 text-[11px] text-text-3">Microfone{phase === "recording" ? " (trocar recomeça a gravação)" : ""}</div>
              <MicPicker conn={conn} value={mic} onChange={changeMic} withTest={phase !== "recording"} />
            </div>
          )}
          {phase === "recording" && (
            <div className="flex flex-col items-center gap-3 py-2">
              <div className="flex max-w-full items-center gap-2 text-[14px] font-semibold text-text-1">
                <span className="relative inline-flex h-3 w-3 shrink-0">
                  <span className="absolute inset-0 animate-ping rounded-full bg-[#DC2626] opacity-75" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-[#DC2626]" />
                </span>
                <span className="truncate">Gravando com {micName}</span>
              </div>
              <div className="font-mono text-[22px] text-text-1">{formatDuration(elapsed)}</div>
              <LevelBar level={level} className="h-3 w-72 max-w-full" />
              {silent ? (
                <div className="rounded bg-status-warn/15 px-2 py-1 text-[12px] font-semibold text-status-warn">
                  Nenhum som captado — verifique o microfone selecionado
                </div>
              ) : (
                <div className="text-center text-[12px] text-text-2">
                  Fale normalmente; a barra se mexe com a sua voz (máx. {MAX_RECORD_MS / 60000} min) · {sttName}
                </div>
              )}
              <div className="flex gap-2">
                <button className="flex items-center gap-1.5 rounded bg-[#DC2626] px-4 py-1.5 font-semibold text-white hover:bg-[#B91C1C]" onClick={stop}>
                  <Square size={13} fill="currentColor" /> Parar e transcrever
                </button>
                <button className="rounded bg-bg-hover px-4 py-1.5 text-text-1 hover:bg-border" onClick={cancel}>
                  Cancelar
                </button>
              </div>
            </div>
          )}
          {overLimit && phase !== "review" && <div className="rounded bg-status-warn/15 p-2 text-[12px] text-status-warn">{overLimit}</div>}
          {(phase === "transcribing" || phase === "correcting") && (
            <div className="space-y-3">
              <Busy
                text={`${phase === "transcribing" ? `Transcrevendo com ${sttName}` : `Corrigindo com ${llmName} (${snap?.settings.llm_model || "modelo padrão"})`}… ${formatSeconds(workMs)}`}
              />
              {phase === "correcting" && (
                <div className="min-h-[3rem] rounded border border-border bg-bg-term p-2 text-[13px] text-text-1">
                  {snap?.settings.show_correction_stream && streamText ? (
                    <>
                      {streamText}
                      <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-accent align-middle" />
                    </>
                  ) : (
                    <span className="text-text-3" title="Texto transcrito; troca pelo corrigido quando a correção terminar">
                      {original}
                    </span>
                  )}
                </div>
              )}
              <div className="flex justify-center gap-2">
                {snap?.settings.llm_enabled && !manualRetry && (
                  <button
                    className="rounded bg-accent px-3 py-1.5 text-white hover:bg-accent-hover disabled:opacity-50"
                    disabled={skipCorrection.current && phase === "transcribing"}
                    onClick={skip}
                    title="Usa o texto transcrito agora, sem esperar a correção"
                  >
                    Pular correção
                  </button>
                )}
                <button className="rounded bg-bg-hover px-3 py-1.5 text-text-1 hover:bg-border" onClick={manualRetry ? cancelManualRetry : cancel}>
                  Cancelar
                </button>
              </div>
            </div>
          )}
          {phase === "error" &&
            (() => {
              const recovery = errorRecovery(errorKind, !!lastAudio.current);
              return (
                <div className="space-y-3">
                  <div className="rounded bg-status-err/10 p-2 text-status-err">{error}</div>
                  <div className="flex flex-wrap gap-2">
                    {recovery.authRequired ? (
                      <button className="rounded bg-accent px-3 py-1.5 text-white hover:bg-accent-hover" onClick={() => onOpenSettings("provedores")}>
                        Configurar em Provedores de IA
                      </button>
                    ) : (
                      <>
                        {recovery.retry && (
                          <button className="rounded bg-accent px-3 py-1.5 text-white hover:bg-accent-hover" onClick={retry}>
                            Tentar novamente
                          </button>
                        )}
                        {recovery.rerecord && snap && (
                          <button
                            className={
                              recovery.retry
                                ? "rounded bg-bg-hover px-3 py-1.5 text-text-1 hover:bg-border"
                                : "rounded bg-accent px-3 py-1.5 text-white hover:bg-accent-hover"
                            }
                            onClick={() => void start(snap, mic)}
                          >
                            Gravar de novo
                          </button>
                        )}
                        <button className="rounded bg-bg-hover px-3 py-1.5 text-text-1 hover:bg-border" onClick={() => onOpenSettings()}>
                          Configurar
                        </button>
                      </>
                    )}
                    <button className="rounded bg-bg-hover px-3 py-1.5 text-text-1 hover:bg-border" onClick={cancel}>
                      Descartar
                    </button>
                  </div>
                </div>
              );
            })()}
          {phase === "review" && (
            <div className="space-y-2">
              {warn && <div className="rounded bg-status-warn/15 p-2 text-[12px] font-semibold text-status-warn">{warn}</div>}
              {corrected !== null && corrected !== original && (
                <div className="rounded border border-border bg-bg-panel p-2 text-[12px] leading-relaxed">
                  <div className="mb-1 flex items-center gap-2 text-[11px] text-text-3">
                    O que a correção mudou
                    <div className="flex-1" />
                    <button className="text-accent-text hover:underline" onClick={() => setText(text === original ? corrected : original)}>
                      {text === original ? "usar corrigido" : "usar original"}
                    </button>
                  </div>
                  {wordDiff(original, corrected).map((d, i) => (
                    <span
                      key={i}
                      className={cn(
                        d.kind === "added" && "rounded-sm bg-status-ok/20 text-text-1",
                        d.kind === "removed" && "text-text-3 line-through",
                        d.kind === "same" && "text-text-2",
                      )}
                    >
                      {d.text}
                    </span>
                  ))}
                </div>
              )}
              <label className="flex items-center gap-2 text-[12px] text-text-2">
                <input type="checkbox" checked={prefixOn} onChange={(e) => setPrefixOn(e.target.checked)} />
                Avisar o agente que veio de voz
              </label>
              {prefixOn && (
                <textarea
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  className="h-14 w-full resize-y rounded border border-border bg-bg-term p-2 text-[12px] text-text-2 outline-none focus:border-accent"
                />
              )}
              <textarea
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="h-40 w-full resize-y rounded border border-border bg-bg-term p-2 text-[13px] text-text-1 outline-none focus:border-accent"
              />
              <div className="text-[11px] text-text-3">
                {info2}
                {cost !== null && ` · custo desta fala: ${formatUSD(cost)}`} · trechos marcados [? ] ficam para o agente ver a dúvida · é colado sem Enter:
                confirme no próprio agente
              </div>
            </div>
          )}
        </div>
        {phase === "review" && (
          <div className="flex items-center gap-2 border-t border-border p-3">
            <button className="rounded px-3 py-1.5 text-text-2 hover:bg-bg-hover hover:text-text-1" onClick={cancel}>
              Descartar
            </button>
            {snap && (
              <button
                className="rounded bg-bg-hover px-3 py-1.5 text-text-1 hover:bg-border"
                onClick={() => {
                  setCorrected(null);
                  setOriginal("");
                  setText("");
                  void start(snap, mic);
                }}
              >
                Gravar de novo
              </button>
            )}
            {snap?.settings.llm_enabled && original.trim() && (
              <button
                className="rounded bg-bg-hover px-3 py-1.5 text-text-1 hover:bg-border"
                onClick={retryCorrection}
                title="Reenvia o texto já transcrito para o corretor, sem gravar de novo"
              >
                Corrigir novamente
              </button>
            )}
            <div className="flex-1" />
            <button
              className="rounded bg-accent px-4 py-1.5 font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
              disabled={!text.trim()}
              onClick={() => send(text, prefixOn, prefix)}
              title="Cola no terminal sem Enter (Ctrl+Enter também envia)"
            >
              Enviar ao terminal
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Busy({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-8 text-text-2">
      <Loader2 size={16} className="animate-spin" /> {text}
    </div>
  );
}
