import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { Check, ImagePlus, Loader2, Mic, Send, X } from "lucide-react";
import type { Connection } from "@/lib/connection";
import { composeMessage } from "@/lib/voice";
import { phonePaste } from "@/lib/phoneScreen";
import { correctStreaming, correctTimeoutMs, transcribe, VoiceError } from "@/lib/voicePipeline";
import { appendDictation, clock } from "./audio";
import { PhoneRecorder } from "./recorder";
import { prepareImage } from "./image";
import { runWithRetry } from "./retry";
import { clearTake, loadTake, saveTake } from "./takeStore";
import { QUICK_KEYS } from "./text";

/** O que o PC deixa o celular saber da voz (phone_gate.go, phoneVoiceView). */
interface PhoneVoice {
  settings: {
    privacy_ack: boolean;
    llm_enabled: boolean;
    prefix_enabled: boolean;
    prefix_text: string;
    correct_timeout_sec?: number;
  };
}

type Phase = "idle" | "privacy" | "starting" | "recording" | "transcribing" | "correcting";

interface Draft {
  text: string;
  /** o texto veio (ao menos em parte) de um ditado: vai com o prefixo de voz */
  voice: boolean;
  /** transcrição antes da correção, para desfazer */
  raw: string | null;
}

// Rascunho por terminal: sair e voltar não perde o que foi ditado.
const drafts = new Map<number, Draft>();
const EMPTY: Draft = { text: "", voice: false, raw: null };

interface Attachment {
  id: number;
  /** miniatura (object URL) */
  preview: string;
  /** link que vai ao terminal, ![image](...); null enquanto sobe */
  text: string | null;
  error?: string;
}

// Imagens anexadas por terminal, como o rascunho.
const attachmentsByPane = new Map<number, Attachment[]>();
let nextAttachment = 1;
const BARS = 36;

interface ComposerProps {
  conn: Connection;
  paneId: number;
  readOnly: boolean;
  /** o terminal chama isto quando a pessoa toca no texto: abre o teclado no campo */
  focusRef?: MutableRefObject<(() => void) | null>;
  /** tamanho da fonte do terminal (A−/A+): o campo usa o mesmo */
  fontSize?: number;
}

export function Composer({ conn, paneId, readOnly, focusRef, fontSize }: ComposerProps) {
  const [draft, setDraftState] = useState<Draft>(() => drafts.get(paneId) ?? EMPTY);
  const [attachments, setAttachmentsState] = useState<Attachment[]>(() => attachmentsByPane.get(paneId) ?? []);
  const attachRef = useRef(attachments);
  attachRef.current = attachments;
  const fileRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);
  const [voice, setVoice] = useState<PhoneVoice | null>(null);
  const [levels, setLevels] = useState<number[]>(() => new Array(BARS).fill(0));
  const [elapsed, setElapsed] = useState(0);
  // áudio gravado que ainda não virou texto: fica guardado até dar certo ou ser descartado
  const [pending, setPending] = useState<{ blob: Blob; seconds: number } | null>(null);
  const recRef = useRef<PhoneRecorder | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const setDraft = (d: Draft) => {
    drafts.set(paneId, d);
    setDraftState(d);
  };

  const setAttachments = (fn: (prev: Attachment[]) => Attachment[]) => {
    const next = fn(attachRef.current);
    attachRef.current = next;
    attachmentsByPane.set(paneId, next);
    setAttachmentsState(next);
  };

  if (focusRef) focusRef.current = () => fieldRef.current?.focus();

  const addImages = (files: FileList | null) => {
    if (!files?.length || readOnly) return;
    setNote(null);
    for (const file of Array.from(files)) {
      const id = nextAttachment++;
      const preview = URL.createObjectURL(file);
      setAttachments((prev) => [...prev, { id, preview, text: null }]);
      void (async () => {
        try {
          const blob = await prepareImage(file);
          const r = await conn.upload<{ text: string }>(`/api/phone/image?pane_id=${paneId}`, blob, blob.type || file.type);
          setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, text: r.text } : a)));
        } catch (e) {
          setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, error: (e as Error).message } : a)));
        }
      })();
    }
  };

  const removeAttachment = (id: number) => {
    setAttachments((prev) => {
      const gone = prev.find((a) => a.id === id);
      if (gone) URL.revokeObjectURL(gone.preview);
      return prev.filter((a) => a.id !== id);
    });
  };

  useEffect(() => {
    void conn
      .api<PhoneVoice>("/api/voice")
      .then(setVoice)
      .catch(() => undefined);
  }, [conn]);

  useEffect(() => {
    let off = false;
    void loadTake(paneId).then((t) => {
      if (off || !t) return;
      setPending({ blob: t.blob, seconds: t.seconds });
      setNote({ text: "Há um áudio gravado que ainda não virou texto. Toque em Tentar de novo.", err: true });
    });
    return () => {
      off = true;
    };
  }, [paneId]);

  useEffect(
    () => () => {
      recRef.current?.cancel();
      abortRef.current?.abort();
    },
    [],
  );

  // O campo cresce com o texto (até ~38% da tela) para a revisão caber.
  useLayoutEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [draft.text, phase]);

  useEffect(() => {
    if (phase !== "recording") return;
    const t = window.setInterval(() => setElapsed(recRef.current?.elapsedMs ?? 0), 250);
    return () => window.clearInterval(t);
  }, [phase]);

  const busy = phase !== "idle" && phase !== "privacy";

  const startRecording = () => {
    setNote(null);
    setLevels(new Array(BARS).fill(0));
    setElapsed(0);
    // Criado aqui, dentro do toque: o iPhone só libera o áudio assim.
    const rec = new PhoneRecorder((level) => setLevels((prev) => [...prev.slice(1), level]));
    recRef.current = rec;
    setPhase("starting");
    rec
      .start()
      .then(() => {
        if (recRef.current !== rec) return;
        navigator.vibrate?.(12);
        setPhase("recording");
      })
      .catch((e: Error) => {
        recRef.current = null;
        setPhase("idle");
        setNote({ text: e.message, err: true });
      });
  };

  const onTalk = () => {
    if (readOnly || busy) return;
    if (!voice) {
      setNote({ text: "Ainda carregando a voz do PC. Tente de novo em instantes.", err: true });
      return;
    }
    if (!voice.settings.privacy_ack) {
      setPhase("privacy");
      return;
    }
    startRecording();
  };

  const cancelRecording = () => {
    recRef.current?.cancel();
    recRef.current = null;
    setPhase("idle");
    setNote({ text: "Gravação descartada." });
  };

  const finishRecording = async () => {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    setPhase("transcribing");
    const take = await rec.stop();
    if (take.choice === "silent") {
      setPhase("idle");
      setNote({
        text: "O microfone não captou som. Veja se outro app está usando o microfone ou se o som do site está bloqueado, e tente de novo.",
        err: true,
      });
      return;
    }
    if (take.choice === "empty") {
      setPhase("idle");
      setNote({ text: "Este navegador não entregou o áudio gravado. Tente de novo; se repetir, atualize o navegador.", err: true });
      return;
    }
    setPending({ blob: take.blob, seconds: take.seconds });
    await saveTake({ paneId, blob: take.blob, seconds: take.seconds, savedAt: Date.now() }).catch(() => undefined);
    await transcribeSaved(take.blob, take.seconds);
  };

  /** Envia o áudio guardado (tenta de novo sozinho se a rede ou o PC falharem). O áudio só some depois de dar certo. */
  const transcribeSaved = async (blob: Blob, seconds: number) => {
    setNote(null);
    setPhase("transcribing");
    const base = draftRef.current;
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const tr = await runWithRetry(() => transcribe(conn, blob, { signal: ac.signal, audioMs: seconds * 1000, pane: paneId }), {
        signal: ac.signal,
        onWait: ({ attempt, delayMs }) =>
          setNote({ text: `Sem resposta do PC. Tentando de novo em ${Math.round(delayMs / 1000)} s (tentativa ${attempt}). O áudio está guardado.` }),
      });
      const heard = tr.text.trim();
      if (!heard) {
        setPhase("idle");
        setNote({ text: "Não reconheci fala nesse áudio. Tente de novo ou descarte.", err: true });
        return;
      }
      await clearTake(paneId);
      setPending(null);
      setNote(null);
      const raw = appendDictation(base.text, heard);
      setDraft({ text: raw, voice: true, raw: null });
      if (voice?.settings.llm_enabled) {
        setPhase("correcting");
        try {
          const c = await correctStreaming(conn, heard, {
            signal: ac.signal,
            timeoutMs: correctTimeoutMs(voice.settings.correct_timeout_sec),
            pane: paneId,
            onDelta: (soFar) => setDraft({ text: appendDictation(base.text, soFar), voice: true, raw }),
          });
          const fixed = c.text.trim() ? appendDictation(base.text, c.text) : raw;
          setDraft({ text: fixed, voice: true, raw: fixed !== raw ? raw : null });
        } catch (e) {
          setDraft({ text: raw, voice: true, raw: null });
          if (!(e instanceof VoiceError && e.canceled)) setNote({ text: `Correção não aplicada: ${(e as Error).message}` });
        }
      }
      setPhase("idle");
    } catch (e) {
      setPhase("idle");
      if ((e as Error).name === "AbortError" || (e instanceof VoiceError && e.canceled)) {
        setNote({ text: "Transcrição cancelada. O áudio continua guardado.", err: true });
        return;
      }
      setNote({ text: `${(e as Error).message}. O áudio está guardado: toque em Tentar de novo.`, err: true });
    } finally {
      abortRef.current = null;
    }
  };

  const discardPending = () => {
    setPending(null);
    setNote({ text: "Áudio descartado." });
    void clearTake(paneId);
  };

  const downloadPending = () => {
    if (!pending) return;
    const url = URL.createObjectURL(pending.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audio-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${pending.blob.type.includes("wav") ? "wav" : pending.blob.type.includes("mp4") ? "m4a" : "webm"}`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const message = (): string | null => {
    const s = voice?.settings;
    if (draft.voice && s) {
      const m = composeMessage(s.prefix_enabled !== false, s.prefix_text, draft.text);
      return m.trim() ? m : null;
    }
    return phonePaste(draft.text);
  };

  const uploading = attachments.some((a) => a.text == null && !a.error);
  const ready = attachments.filter((a) => a.text).map((a) => a.text as string);

  const send = () => {
    if (readOnly || busy || uploading) return;
    const body = message();
    // Imagens primeiro, uma por linha; depois o texto.
    const m = [...ready, ...(body ? [body] : [])].join("\n");
    if (!m) return;
    if (!conn.paste(paneId, m)) {
      setNote({ text: "Sem conexão com o PC. O texto continua aqui; envie quando voltar.", err: true });
      return;
    }
    window.setTimeout(() => conn.send(paneId, "\r"), 40);
    navigator.vibrate?.(10);
    setDraft(EMPTY);
    attachRef.current.forEach((a) => URL.revokeObjectURL(a.preview));
    setAttachments(() => []);
    setNote({ text: "Enviado." });
    conn.scroll(paneId, 0);
  };

  const key = (data: string) => {
    if (readOnly) return;
    if (!conn.send(paneId, data)) setNote({ text: "Sem conexão com o PC.", err: true });
  };

  const hasText = draft.text.trim().length > 0 || attachments.length > 0;
  const showPrefix = draft.voice && hasText && voice?.settings.prefix_enabled !== false && voice?.settings.prefix_text.trim();

  return (
    <div className="p-dock">
      {phase === "idle" && !hasText && !readOnly && (
        <div className="p-keys" role="toolbar" aria-label="Teclas rápidas">
          {QUICK_KEYS.map((k) => (
            <button key={k.label} type="button" className="p-key" aria-label={k.aria} onClick={() => key(k.data)}>
              {k.label}
            </button>
          ))}
        </div>
      )}

      {phase === "privacy" && (
        <div className="p-card">
          O áudio vai para o PC, que o transcreve com o provedor de voz configurado lá. Nada entra no terminal antes de você revisar e tocar em Enviar.
          <div className="p-card__row">
            <button
              type="button"
              className="p-btn p-btn--primary"
              onClick={() => {
                if (!voice) return;
                const next = { ...voice, settings: { ...voice.settings, privacy_ack: true } };
                setVoice(next);
                // Objeto inteiro: no domínio do celular o Go só lê privacy_ack; aberto no PC
                // (teste local) a rota é a do Studio, que troca as configurações todas.
                void conn.api("/api/voice/settings", next.settings).catch(() => undefined);
                startRecording();
              }}
            >
              Entendi, gravar
            </button>
            <button type="button" className="p-btn p-btn--quiet" onClick={() => setPhase("idle")}>
              Agora não
            </button>
          </div>
        </div>
      )}

      {phase === "idle" && draft.voice && hasText && (
        <div className="p-review">
          Revise o ditado. Nada foi enviado ainda.
          {showPrefix && <div className="p-prefix">Vai com o aviso de ditado por voz na primeira linha.</div>}
          <div className="p-review__row">
            {draft.raw != null && (
              <button type="button" className="p-link" onClick={() => setDraft({ text: draft.raw ?? draft.text, voice: true, raw: null })}>
                Voltar ao que foi transcrito
              </button>
            )}
            <button
              type="button"
              className="p-link"
              onClick={() => {
                setDraft(EMPTY);
                setNote(null);
              }}
            >
              Apagar
            </button>
          </div>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="p-thumbs" aria-label="Imagens anexadas">
          {attachments.map((a) => (
            <div key={a.id} className={a.error ? "p-thumb p-thumb--err" : "p-thumb"} title={a.error}>
              <img src={a.preview} alt="Imagem anexada" />
              {a.text == null && !a.error && (
                <span className="p-thumb__busy">
                  <Loader2 size={18} className="p-spin" />
                </span>
              )}
              <button type="button" aria-label="Tirar esta imagem" onClick={() => removeAttachment(a.id)}>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      {attachments.some((a) => a.error) && (
        <p className="p-note p-note--err" role="alert">
          {attachments.find((a) => a.error)?.error} Toque no × para tirar a imagem.
        </p>
      )}

      {note && (
        <p className={note.err ? "p-note p-note--err" : "p-note"} role={note.err ? "alert" : "status"}>
          {note.text}
        </p>
      )}

      {pending && phase === "idle" && (
        <div className="p-busy" role="group" aria-label="Áudio guardado">
          <span className="p-busy__txt">Áudio guardado ({clock(pending.seconds * 1000)})</span>
          <button type="button" className="p-btn" onClick={() => void transcribeSaved(pending.blob, pending.seconds)}>
            Tentar de novo
          </button>
          <button type="button" className="p-btn p-btn--quiet" onClick={downloadPending}>
            Baixar
          </button>
          <button type="button" className="p-btn p-btn--quiet" onClick={discardPending}>
            Descartar
          </button>
        </div>
      )}

      {(phase === "transcribing" || phase === "correcting") && (
        <div className="p-busy" role="status">
          <Loader2 size={18} className="p-spin" />
          <span className="p-busy__txt">{phase === "transcribing" ? "Transcrevendo no PC…" : "Corrigindo o texto…"}</span>
          <button type="button" className="p-btn p-btn--quiet" onClick={() => abortRef.current?.abort()}>
            {phase === "transcribing" ? "Cancelar" : "Pular correção"}
          </button>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          addImages(e.target.files);
          e.target.value = "";
        }}
      />

      {phase === "recording" || phase === "starting" ? (
        <div className="p-rec">
          <button type="button" className="p-round p-round--soft" aria-label="Descartar gravação" onClick={cancelRecording}>
            <X size={22} />
          </button>
          <div className="p-rec__meter" aria-label={phase === "starting" ? "Abrindo o microfone" : `Gravando, ${clock(elapsed)}`}>
            <span className="p-rec__dot" aria-hidden="true" />
            <span className="p-rec__time">{phase === "starting" ? "0:00" : clock(elapsed)}</span>
            <span className="p-rec__bars" aria-hidden="true">
              {levels.map((l, i) => (
                <span key={i} style={{ height: `${Math.max(3, Math.round(l * 26))}px` }} />
              ))}
            </span>
          </div>
          <button
            type="button"
            className="p-round p-round--rec"
            aria-label="Terminar e transcrever"
            disabled={phase === "starting"}
            onClick={() => void finishRecording()}
          >
            <Check size={24} />
          </button>
        </div>
      ) : (
        <div className="p-compose">
          <button
            type="button"
            className="p-round p-round--ghost"
            aria-label="Anexar imagem ou print"
            disabled={readOnly || busy || phase === "privacy"}
            onClick={() => fileRef.current?.click()}
          >
            <ImagePlus size={22} />
          </button>
          <textarea
            ref={fieldRef}
            className={busy ? "p-field p-field--busy" : "p-field"}
            rows={1}
            style={fontSize ? { fontSize: `${fontSize}px` } : undefined}
            value={draft.text}
            readOnly={phase === "correcting"}
            disabled={readOnly || phase === "transcribing"}
            placeholder={readOnly ? "O PC está em somente leitura" : "Escreva ou toque no microfone"}
            aria-label="Mensagem para o terminal"
            enterKeyHint="enter"
            onChange={(e) => {
              const text = e.target.value;
              setDraft({ text, voice: draft.voice && text.trim() !== "", raw: draft.raw });
              if (note) setNote(null);
            }}
          />
          {hasText ? (
            <>
              <button
                type="button"
                className="p-round p-round--ghost"
                aria-label="Ditar mais"
                disabled={readOnly || busy || phase === "privacy"}
                onClick={onTalk}
              >
                <Mic size={22} />
              </button>
              <button
                type="button"
                className="p-round p-round--brand"
                aria-label={uploading ? "Subindo imagem" : "Enviar"}
                disabled={readOnly || busy || uploading}
                onClick={send}
              >
                {uploading ? <Loader2 size={20} className="p-spin" /> : <Send size={20} />}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="p-round p-round--brand"
              aria-label="Falar"
              disabled={readOnly || busy || phase === "privacy"}
              onClick={onTalk}
            >
              <Mic size={22} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
