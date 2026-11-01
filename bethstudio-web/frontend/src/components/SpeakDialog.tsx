import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { Copy, History, Loader2, Mic, Pause, Play, RotateCcw, Send, Settings2, Square, Trash2, X } from "lucide-react";
import type { Connection } from "@/lib/connection";
import type { PaneInfo } from "@/lib/types";
import { paneLabel } from "@/lib/panes";
import { loadPref, savePref } from "@/lib/filePreview";
import { SPEAK_POS_KEY, initialPos, isPos, keepInside, type Pos } from "@/lib/speakPos";
import {
  MAX_RECORD_MS,
  composeMessage,
  formatDuration,
  isLongPaste,
  loadVoice,
  pasteAsFile,
  micErrorMessage,
  saveVoice,
  wordDiff,
  type VoiceSnapshot,
} from "@/lib/voice";
import { SilenceWatch, audioConstraints, blobProblem, micLog, pickMimeType, resolveMic, type MicChoice, type MicDevice } from "@/lib/mic";
import {
  DEFAULT_TUNING,
  GAIN_DB_MAX,
  GAIN_DB_MIN,
  MIC_TUNING_KEY,
  CaptureWatch,
  PeakHold,
  dbToGain,
  formatGainDb,
  formatLevelDb,
  gainToDb,
  isMicTuning,
  levelHint,
  normalizeTuning,
  peakOf,
  rmsOfFloat,
  type MicTuning,
} from "@/lib/micTuning";
import { RecClock } from "@/lib/recClock";
import { MicPicker } from "./MicPicker";
import { LevelScope, type ScopeHandle } from "./LevelScope";
import { VoiceError, correctStreaming, correctTimeoutMs, errorRecovery, formatSeconds, formatUSD, transcribe, type VoiceErrorKind } from "@/lib/voicePipeline";
import type { SettingsSection } from "./SettingsDialog";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { SPEAK_HISTORY_KEY, addEntry, isEntryList, newEntryId, preview, removeEntry, updateEntry, type SpeakEntry } from "@/lib/speakHistory";

const loadHistory = () => loadPref<SpeakEntry[]>(SPEAK_HISTORY_KEY, [], isEntryList);

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
  const [readout, setReadout] = useState<{ hold: number; now: number }>({ hold: 0, now: 0 });
  const [tuning, setTuning] = useState<MicTuning>(() => normalizeTuning(loadPref<MicTuning>(MIC_TUNING_KEY, DEFAULT_TUNING, isMicTuning)));
  const [showTuning, setShowTuning] = useState(false);
  const tuningRef = useRef(tuning);
  tuningRef.current = tuning;
  const scopeRef = useRef<ScopeHandle>(null);
  const gainRef = useRef<GainNode | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
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
  const [history, setHistory] = useState<SpeakEntry[]>(loadHistory);
  const [showHistory, setShowHistory] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [histNote, setHistNote] = useState("");
  const entryId = useRef(""); // fala atual no histórico
  const [manualRetry, setManualRetry] = useState(false); // "Corrigir novamente": so' a correção, sem regravar
  const work = useRef<AbortController | null>(null); // transcricao/correcao em andamento
  const skipCorrection = useRef(false);
  const recStart = useRef(0);
  const clockRef = useRef<RecClock | null>(null); // tempo gravado, sem as pausas
  const [paused, setPaused] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const acRef = useRef<AudioContext | null>(null);
  const discard = useRef(false); // o proximo onstop joga o audio fora
  const busy = useRef(false); // um getUserMedia/gravacao por vez
  const restart = useRef(false); // o proximo onstop recomeca a captacao
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
    gainRef.current = null;
    trackRef.current = null;
  };

  /** Muda o volume de entrada ao vivo e lembra para as próximas falas. */
  const setGainDb = (db: number) => {
    const next = { ...tuningRef.current, gain: dbToGain(db) };
    setTuning(next);
    savePref(MIC_TUNING_KEY, next);
    const gn = gainRef.current;
    if (gn) gn.gain.value = next.gain;
  };

  /** Liga/desliga um processamento do navegador; vale já na gravação em curso. */
  const toggleProc = (key: "agc" | "ns" | "echo") => {
    const next = { ...tuningRef.current, [key]: !tuningRef.current[key] };
    setTuning(next);
    savePref(MIC_TUNING_KEY, next);
    const tr = trackRef.current;
    if (tr && tr.readyState === "live") {
      const c: MediaTrackConstraints = { echoCancellation: next.echo, noiseSuppression: next.ns, autoGainControl: next.agc };
      tr.applyConstraints(c).catch((e) => log(`ajuste de áudio ao vivo recusado (${(e as Error).name}); vale na próxima gravação`));
    }
  };

  /** Grava/atualiza o histórico (localStorage) e a lista na tela. */
  const commit = (fn: (l: SpeakEntry[]) => SpeakEntry[]) => {
    const next = fn(loadHistory());
    savePref(SPEAK_HISTORY_KEY, next);
    setHistory(next);
  };

  const send = (body: string, pOn: boolean, p: string, id = entryId.current) => {
    const msg = composeMessage(pOn, p, body);
    if (!msg.trim()) return;
    if (id) commit((l) => updateEntry(l, id, { text: body, sent: true }));
    const done = (note: string) => {
      propsRef.current.onSent(note);
      propsRef.current.onClose();
    };
    if (!isLongPaste(msg)) {
      conn.paste(pane, msg); // bracketed paste, sem Enter
      done("Texto colado no terminal — revise e aperte Enter no agente");
      return;
    }
    // Texto enorme: alguns agentes recusam a colagem. Grava num arquivo temporário
    // e cola só uma instrução curta apontando para ele; se falhar, cola o texto mesmo.
    void pasteAsFile(conn, pane, msg)
      .then((r) => {
        log(`texto longo (${msg.length} caracteres) salvo em ${r.path}`);
        conn.paste(pane, r.text);
        done("Texto longo salvo em arquivo; a instrução para ler foi colada — revise e aperte Enter no agente");
      })
      .catch((e) => {
        log(`texto longo: não consegui gravar o arquivo (${(e as Error).message}); colando o texto direto`);
        conn.paste(pane, msg);
        done("Texto colado no terminal — revise e aperte Enter no agente");
      });
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
      // guarda ANTES de enviar: se o envio falhar ou o agente cortar o texto, dá para copiar daqui
      entryId.current = newEntryId();
      commit((l) =>
        addEntry(l, {
          id: entryId.current,
          at: Date.now(),
          text: final,
          original: final !== tr.text ? tr.text : undefined,
          target: info ? paneLabel(info) : `terminal ${pane}`,
          sent: false,
        }),
      );
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

  /** getUserMedia que não fica pendurado: o Windows às vezes nunca responde. */
  const openMic = (c: MediaStreamConstraints) =>
    new Promise<MediaStream>((res, rej) => {
      let late = false;
      const t = window.setTimeout(() => {
        late = true;
        rej(new DOMException("getUserMedia não respondeu em 8 s", "TimeoutError"));
      }, 8000);
      navigator.mediaDevices.getUserMedia(c).then(
        (st) => {
          window.clearTimeout(t);
          if (late) st.getTracks().forEach((x) => x.stop());
          else res(st);
        },
        (e) => {
          window.clearTimeout(t);
          if (!late) rej(e);
        },
      );
    });

  // attempt 1 = recomeço automático, sem ganho nem medidor (grava o fluxo cru)
  const start = async (s: VoiceSnapshot, choice: MicChoice, attempt = 0): Promise<void> => {
    if (busy.current || closed.current) {
      log("start ignorado: já há uma gravação em andamento");
      return;
    }
    busy.current = true;
    discard.current = false;
    setError(null);
    setSilent(false);
    setElapsed(0);
    setReadout({ hold: 0, now: 0 });
    scopeRef.current?.clear();
    try {
      let deviceId = "";
      if (choice.id) {
        const r = resolveMic((await navigator.mediaDevices.enumerateDevices()) as MicDevice[], choice);
        deviceId = r.deviceId;
        if (!r.found) log(`microfone salvo "${choice.label}" não encontrado; usando o padrão`);
      }
      log(`getUserMedia (${deviceId ? `"${choice.label}"` : "padrão do Windows"})`);
      const tn = tuningRef.current;
      const stream = await openMic({ audio: audioConstraints(deviceId, tn) });
      if (closed.current) {
        stream.getTracks().forEach((t) => t.stop());
        busy.current = false;
        return;
      }
      streamRef.current = stream;
      const track = stream.getAudioTracks()[0];
      trackRef.current = track ?? null;
      // Grafo de áudio: microfone -> ganho -> (medidor + gravador). O gravador
      // pega a saída do ganho, então o volume escolhido vai para o áudio enviado.
      // Se o AudioContext falhar, grava o fluxo cru (sem ganho e sem medidor).
      let recStream: MediaStream = stream;
      let an: AnalyserNode | null = null;
      try {
        if (attempt > 0) throw new Error("recomeço: sem grafo de áudio");
        const ac = new AudioContext();
        acRef.current = ac;
        // contexto "suspended" não entrega áudio ao gravador: espera ligar de verdade
        await Promise.race([ac.resume().catch(() => undefined), new Promise((r) => window.setTimeout(r, 1500))]);
        if (ac.state !== "running") throw new Error(`AudioContext ${ac.state}`);
        const src = ac.createMediaStreamSource(stream);
        const gn = ac.createGain();
        gn.gain.value = dbToGain(gainToDb(tn.gain));
        gainRef.current = gn;
        an = ac.createAnalyser();
        an.fftSize = 1024;
        const dest = ac.createMediaStreamDestination();
        src.connect(gn);
        gn.connect(an);
        gn.connect(dest);
        recStream = dest.stream;
      } catch (e) {
        log(`grafo de áudio falhou (${(e as Error).message ?? "?"}); gravando sem ganho e sem medidor`);
        void acRef.current?.close().catch(() => undefined);
        acRef.current = null;
        gainRef.current = null;
        an = null;
        recStream = stream;
      }
      const name = track?.label || choice.label || "microfone padrão";
      setMicName(name);
      log(`getUserMedia ok: "${name}" (enabled=${track?.enabled}, muted=${track?.muted}, estado=${track?.readyState})`);
      const mime = pickMimeType((m) => MediaRecorder.isTypeSupported(m));
      log(`MediaRecorder mimeType "${mime || "(padrão do navegador)"}"`);
      const rec = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
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
        if (restart.current) {
          // captação morta: recomeça sozinho, uma vez, sem o usuário cancelar
          restart.current = false;
          discard.current = false;
          log("recomeçando a captação (sem sinal nenhum nos primeiros 2 s)");
          void start(s, choice, attempt + 1);
          return;
        }
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
        const audioMs = clockRef.current ? clockRef.current.elapsed(Date.now()) : Date.now() - recStart.current;
        setPaused(false);
        lastAudio.current = { blob, audioMs };
        void process(blob, s, audioMs);
      };
      recRef.current = rec;
      rec.start(250);
      recStart.current = Date.now();
      clockRef.current = new RecClock(recStart.current);
      setPaused(false);
      log(`start (estado ${rec.state})`);
      setPhase("recording");
      // nivel, tempo e aviso de silencio
      const buf = new Float32Array(an?.fftSize ?? 1024);
      const watch = new SilenceWatch();
      const holder = new PeakHold();
      const dead = new CaptureWatch();
      let warned = false;
      let lastShown = 0;
      const tick = () => {
        // pausado continua no laço: o medidor segue vivo para ver quando o barulho passou
        if (recRef.current !== rec || (rec.state !== "recording" && rec.state !== "paused")) return;
        let l = 0;
        if (an) {
          an.getFloatTimeDomainData(buf);
          const pk = peakOf(buf);
          l = rmsOfFloat(buf);
          const hold = holder.feed(pk, performance.now());
          if (attempt === 0 && dead.feed(pk, clockRef.current?.elapsed(Date.now()) ?? 0)) {
            restart.current = true;
            discard.current = true;
            rec.stop();
            return;
          }
          scopeRef.current?.push(pk, l, hold);
          if (performance.now() - lastShown >= 100) {
            lastShown = performance.now();
            setReadout({ hold, now: pk });
          }
        }
        const now = Date.now();
        // na pausa o silêncio é esperado: não avisa e zera a contagem
        const quiet = an ? watch.feed(rec.state === "paused" ? 1 : l, now) : false;
        setSilent(quiet);
        if (quiet && !warned) {
          warned = true;
          log("aviso: nenhum som captado por 3 s");
        }
        const el = clockRef.current?.elapsed(now) ?? 0;
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
      if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      busy.current = false;
    };
  }, [conn]);

  const stop = () => {
    const st = recRef.current?.state;
    if (recRef.current && (st === "recording" || st === "paused")) {
      log(`parar (usuário${st === "paused" ? ", estava pausado" : ""})`);
      recRef.current.stop();
    }
  };
  /** Pausa/continua: o áudio dito na pausa não entra na gravação. */
  const togglePause = () => {
    const rec = recRef.current;
    const clock = clockRef.current;
    if (!rec || !clock) return;
    if (rec.state === "recording") {
      rec.pause();
      clock.pause(Date.now());
      setPaused(true);
      log("pausar (usuário)");
    } else if (rec.state === "paused") {
      rec.resume();
      clock.resume(Date.now());
      setPaused(false);
      log("continuar (usuário)");
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
        if (entryId.current) commit((l) => updateEntry(l, entryId.current, { text: c.text }));
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
    if (rec && (rec.state === "recording" || rec.state === "paused")) {
      discard.current = true;
      const prev = rec.onstop;
      rec.onstop = (ev) => {
        prev?.call(rec, ev);
        void startRef.current(s2, c);
      };
      rec.stop();
    }
  };

  /** Descarta a gravação em curso e começa outra, com o mesmo microfone. */
  const restartRecording = () => {
    const rec = recRef.current;
    if (!rec || !snap || (rec.state !== "recording" && rec.state !== "paused")) return;
    log("reiniciar gravação (usuário)");
    discard.current = true;
    const prev = rec.onstop;
    rec.onstop = (ev) => {
      prev?.call(rec, ev);
      void startRef.current(snap, mic);
    };
    rec.stop();
  };

  const sttName = snap?.providers.find((p) => p.id === snap.settings.stt_provider)?.name ?? "";
  const llmName = snap?.settings.llm_enabled ? snap?.providers.find((p) => p.id === snap.settings.llm_provider)?.name : undefined;

  return (
    <div className="pointer-events-none fixed inset-0 z-[60]">
      <div
        ref={boxRef}
        style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? "visible" : "hidden" }}
        className={cn(
          "pointer-events-auto absolute flex max-h-[84vh] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-card shadow-2xl",
          // gravando: cartão compacto, para não cobrir o texto que se quer ler atrás
          phase === "recording" ? "w-[min(380px,94vw)]" : "w-[min(640px,94vw)]",
        )}
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
          <button
            className={cn("flex items-center gap-1 rounded p-1 text-text-2 hover:bg-bg-hover hover:text-text-1", showHistory && "bg-bg-hover text-text-1")}
            title="Histórico das últimas transcrições"
            onClick={() => setShowHistory((v) => !v)}
          >
            <History size={15} />
            {history.length > 0 && <span className="text-[11px]">{history.length}</span>}
          </button>
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
          {(phase === "privacy" || phase === "error") && snap && (
            <div className="rounded border border-border bg-bg-panel p-2">
              <div className="mb-1 text-[11px] text-text-3">Microfone</div>
              <MicPicker conn={conn} value={mic} onChange={changeMic} withTest />
            </div>
          )}
          {phase === "recording" && (
            <div className="flex flex-col items-center gap-2">
              <div className="flex w-full items-center gap-2 text-[13px] font-semibold text-text-1">
                <span className="relative inline-flex h-3 w-3 shrink-0">
                  {!paused && <span className="absolute inset-0 animate-ping rounded-full bg-[#DC2626] opacity-75" />}
                  <span className={cn("relative inline-flex h-3 w-3 rounded-full", paused ? "bg-status-warn" : "bg-[#DC2626]")} />
                </span>
                <span className="min-w-0 flex-1 truncate" title={micName}>
                  {paused ? "Pausado" : "Gravando"} · {micName}
                </span>
                <span className={cn("shrink-0 font-mono text-[18px]", paused ? "text-status-warn" : "text-text-1")}>{formatDuration(elapsed)}</span>
              </div>
              <div className="w-full space-y-1">
                <LevelScope ref={scopeRef} className="h-12" />
                {(() => {
                  const hint = levelHint(readout.hold);
                  return (
                    <div className="flex items-center justify-between gap-2 text-[12px]">
                      <span
                        className={cn(
                          "font-semibold",
                          hint.tone === "ok" && "text-status-ok",
                          hint.tone === "warn" && "text-status-warn",
                          hint.tone === "err" && "text-status-err",
                          hint.tone === "idle" && "text-text-3",
                        )}
                      >
                        {hint.text}
                      </span>
                      <span className="shrink-0 font-mono text-text-2" title="Pico retido (dBFS). 0 dB é o máximo antes de estourar.">
                        pico {formatLevelDb(readout.hold)}
                      </span>
                    </div>
                  );
                })()}
                <div className="flex items-center gap-2 text-[12px] text-text-2">
                  <span className="shrink-0">Volume de entrada</span>
                  <input
                    type="range"
                    className="min-w-0 flex-1 accent-[var(--accent,#3B82F6)]"
                    min={GAIN_DB_MIN}
                    max={GAIN_DB_MAX}
                    step={1}
                    value={gainToDb(tuning.gain)}
                    onChange={(e) => setGainDb(Number(e.target.value))}
                    title="Aumenta ou diminui o volume do que é gravado, na hora"
                  />
                  <span className="w-14 shrink-0 text-right font-mono text-text-1">{formatGainDb(gainToDb(tuning.gain))}</span>
                  <button
                    className="shrink-0 rounded px-1.5 py-0.5 text-text-2 hover:bg-bg-hover hover:text-text-1 disabled:opacity-40"
                    disabled={gainToDb(tuning.gain) === 0}
                    onClick={() => setGainDb(0)}
                    title="Voltar para 0 dB"
                  >
                    0 dB
                  </button>
                </div>
                <button className="text-[11px] text-accent-text hover:underline" onClick={() => setShowTuning((v) => !v)}>
                  {showTuning ? "Esconder microfone e ajustes" : "Microfone e ajustes de áudio"}
                </button>
                {showTuning && snap && (
                  <div className="rounded border border-border bg-bg-panel p-2">
                    <div className="mb-1 text-[11px] text-text-3">Microfone (trocar recomeça a gravação)</div>
                    <MicPicker conn={conn} value={mic} onChange={changeMic} withTest={false} />
                  </div>
                )}
                {showTuning && (
                  <div className="space-y-1 rounded border border-border bg-bg-panel p-2 text-[12px] text-text-1">
                    {(
                      [
                        ["agc", "Controle automático de ganho", "O navegador sobe e desce o volume sozinho. Desligue se o volume pulando atrapalha."],
                        ["ns", "Supressão de ruído", "Reduz ventilador e chiado. Desligue se estiver cortando o início das palavras."],
                        ["echo", "Cancelamento de eco", "Só faz diferença se o som do computador volta para o microfone."],
                      ] as const
                    ).map(([k, label, tip]) => (
                      <label key={k} className="flex cursor-pointer items-center gap-2" title={tip}>
                        <input type="checkbox" checked={tuning[k]} onChange={() => toggleProc(k)} />
                        {label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
              {paused ? (
                <div className="rounded bg-status-warn/15 px-2 py-1 text-center text-[12px] font-semibold text-status-warn">
                  Pausado — o que for dito agora NÃO entra na gravação. Aperte Continuar quando o ambiente estiver calmo.
                </div>
              ) : silent ? (
                <div className="rounded bg-status-warn/15 px-2 py-1 text-[12px] font-semibold text-status-warn">
                  Nenhum som captado — verifique o microfone selecionado
                </div>
              ) : null}
              <div className="flex w-full flex-wrap justify-center gap-1.5">
                <button
                  className={cn(
                    "flex items-center gap-1.5 rounded px-3 py-1.5 font-semibold",
                    paused ? "bg-status-ok text-white hover:opacity-90" : "bg-bg-hover text-text-1 hover:bg-border",
                  )}
                  onClick={togglePause}
                  title={paused ? "Voltar a gravar" : "Pausa a gravação: nada do que for dito entra no áudio"}
                >
                  {paused ? <Play size={13} fill="currentColor" /> : <Pause size={13} fill="currentColor" />} {paused ? "Continuar" : "Pausar"}
                </button>
                <button
                  className="flex items-center gap-1.5 rounded bg-bg-hover px-3 py-1.5 text-text-1 hover:bg-border"
                  onClick={restartRecording}
                  title="Descarta o que foi gravado até agora e começa de novo (útil quando a captação não pegou)"
                >
                  <RotateCcw size={13} /> Reiniciar
                </button>
                <button className="flex items-center gap-1.5 rounded bg-[#DC2626] px-3 py-1.5 font-semibold text-white hover:bg-[#B91C1C]" onClick={stop} title="Para a gravação e transcreve (máx. 10 min por gravação)">
                  <Square size={13} fill="currentColor" /> Transcrever
                </button>
                <button className="rounded bg-bg-hover px-3 py-1.5 text-text-1 hover:bg-border" onClick={cancel}>
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
          {showHistory && (
            <div className="rounded border border-border bg-bg-panel">
              <div className="flex items-center gap-2 border-b border-border px-2 py-1.5 text-[11px] text-text-3">
                Últimas transcrições (guardadas só neste computador)
                <div className="flex-1" />
                {histNote && <span className="text-status-ok">{histNote}</span>}
                {history.length > 0 && (
                  <button className="text-accent-text hover:underline" onClick={() => commit(() => [])}>
                    limpar tudo
                  </button>
                )}
              </div>
              {history.length === 0 && <div className="p-3 text-[12px] text-text-3">Nada ainda: cada fala transcrita aparece aqui, mesmo se o envio falhar.</div>}
              <ul className="max-h-64 divide-y divide-border overflow-y-auto">
                {history.map((h) => (
                  <li key={h.id} className="p-2 text-[12px]">
                    <div className="flex items-center gap-2">
                      <button className="min-w-0 flex-1 truncate text-left text-text-1 hover:underline" title="Ver o texto inteiro" onClick={() => setOpenId(openId === h.id ? null : h.id)}>
                        {preview(h.text)}
                      </button>
                      <span className="shrink-0 text-[11px] text-text-3">
                        {new Date(h.at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} · {h.text.length} car.{h.sent ? " · enviado" : ""}
                      </span>
                      <button
                        className="rounded p-1 text-text-2 hover:bg-bg-hover hover:text-text-1"
                        title="Copiar o texto"
                        onClick={() => void copyText(h.text).then((ok) => { setHistNote(ok ? "copiado" : "não foi possível copiar"); window.setTimeout(() => setHistNote(""), 2000); })}
                      >
                        <Copy size={13} />
                      </button>
                      <button
                        className="rounded p-1 text-text-2 hover:bg-bg-hover hover:text-text-1"
                        title="Colar de novo neste terminal (sem Enter e sem o aviso de voz)"
                        onClick={() => send(h.text, false, "", h.id)}
                      >
                        <Send size={13} />
                      </button>
                      <button className="rounded p-1 text-text-2 hover:bg-bg-hover hover:text-text-1" title="Remover do histórico" onClick={() => commit((l) => removeEntry(l, h.id))}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                    {openId === h.id && (
                      <textarea readOnly value={h.text} className="mt-2 h-40 w-full resize-y rounded border border-border bg-bg-term p-2 text-[12px] text-text-1 outline-none" />
                    )}
                  </li>
                ))}
              </ul>
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
