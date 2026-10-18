// Cola da gravação nativa: microfone (expo-audio) -> trechos em arquivo no
// disco -> fila persistente -> envio ao PC -> texto pronto. Toda decisão está
// nos módulos puros (queue, sender, segmented, api); aqui só se liga o
// aparelho (permissão, disco, AsyncStorage, timers).
//
// Estado exposto por subscribe/getSnapshot (useSyncExternalStore).

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { AudioModule, AudioQuality, getRecordingPermissionsAsync, IOSOutputFormat, requestRecordingPermissionsAsync, setAudioModeAsync, type RecordingOptions } from "expo-audio";
import { Directory, File, Paths } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import * as Sharing from "expo-sharing";
import { PhoneApi } from "./api";
import { nativeHttp } from "./http";
import {
  addPart,
  dueTakes,
  expedite,
  finishRecording,
  manualRetry,
  newTake,
  nextWakeAt,
  parseQueue,
  recoverInterrupted,
  type Take,
} from "./queue";
import { isSilent, meterLevel, pickRecordedFile } from "./recordedFile";
import { SegmentedRecorder, type RecorderLike } from "./segmented";
import { processTake } from "./sender";

const QUEUE_KEY = "bethstudio.voice.queue.v1";
/** Trecho de gravação: cada .m4a fechado já é um áudio completo no disco. */
const SEGMENT_MS = 120_000;
/** 32 kbps mono 16 kHz: voz clara, ~240 KB por minuto (o PC aceita até 25 MB). */
const RECORDING: RecordingOptions = {
  extension: ".m4a",
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 32000,
  isMeteringEnabled: true,
  directory: "document",
  android: { extension: ".m4a", outputFormat: "mpeg4", audioEncoder: "aac" },
  ios: {
    extension: ".m4a",
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.MEDIUM,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: { mimeType: "audio/webm", bitsPerSecond: 32000 },
};

export interface VoiceSnapshot {
  takes: Take[];
  recording: { startedAt: number } | null;
  /** 0..1, do medidor do microfone */
  level: number;
  /** aviso passageiro para a tela (erro de permissão, "sem som"...) */
  notice: { text: string; error: boolean } | null;
}

type Listener = () => void;

class AudioFile implements RecorderLike {
  uri: string | null = null;
  // eslint-disable-next-line import/namespace -- AudioModule é a classe nativa; o plugin de import não resolve o tipo
  private rec = new AudioModule.AudioRecorder({
    extension: RECORDING.extension,
    sampleRate: RECORDING.sampleRate,
    numberOfChannels: RECORDING.numberOfChannels,
    bitRate: RECORDING.bitRate,
    isMeteringEnabled: true,
    directory: "document",
  });
  async prepareToRecordAsync() {
    await this.rec.prepareToRecordAsync(RECORDING);
    this.uri = this.rec.uri;
  }
  record() {
    this.rec.record();
  }
  async stop() {
    await this.rec.stop();
    this.uri = this.rec.uri ?? this.uri;
  }
  getStatus() {
    return this.rec.getStatus() as { metering?: number };
  }
}

export class VoiceService {
  private snap: VoiceSnapshot = { takes: [], recording: null, level: 0, notice: null };
  private listeners = new Set<Listener>();
  private api: PhoneApi | null = null;
  private recorder: SegmentedRecorder | null = null;
  private current: Take | null = null;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;
  private ready = false;

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.snap;

  private set(patch: Partial<VoiceSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }

  notice(text: string, error = false) {
    this.set({ notice: { text, error } });
  }
  dismissNotice = () => this.set({ notice: null });

  // ---------------------------------------------------------------- ciclo de vida

  /** Chame ao ter domínio e senha. Recarrega a fila do disco e retoma o envio. */
  async init(host: string, getPassword: () => Promise<string | null>): Promise<void> {
    this.api = new PhoneApi({ host, getPassword, http: nativeHttp });
    const takes = recoverInterrupted(parseQueue(await AsyncStorage.getItem(QUEUE_KEY).catch(() => null)), Date.now());
    this.snap = { ...this.snap, takes };
    this.ready = true;
    await this.persist();
    this.listeners.forEach((l) => l());
    void this.pump();
  }

  /** Sair / trocar de servidor: pára o envio. A fila e os arquivos ficam. */
  shutdown() {
    this.ready = false;
    this.api = null;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
  }

  /** Voltou para o app ou a rede voltou: o que esperava a próxima tentativa vai agora. */
  wake = () => {
    if (!this.ready) return;
    this.set({ takes: expedite(this.snap.takes, Date.now()) });
    void this.persist();
    void this.pump();
  };

  private async persist() {
    try {
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(this.snap.takes));
    } catch {
      /* o arquivo de áudio continua no disco; a fila volta a ser salva no próximo passo */
    }
  }

  private replace(t: Take) {
    const takes = this.snap.takes.some((x) => x.id === t.id) ? this.snap.takes.map((x) => (x.id === t.id ? t : x)) : [...this.snap.takes, t];
    this.set({ takes });
    return this.persist();
  }

  // ---------------------------------------------------------------- gravação

  /** Pede o microfone (o sistema só pergunta uma vez) e começa a gravar. Devolve false se não deu. */
  async startRecording(): Promise<boolean> {
    if (this.recorder || !this.ready) return false;
    let perm = await getRecordingPermissionsAsync();
    if (!perm.granted && perm.canAskAgain) perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      this.notice("O microfone está bloqueado para o Beth Studio. Libere em Ajustes do aparelho → Beth Studio → Microfone.", true);
      return false;
    }
    try {
      await new Directory(Paths.document).create({ intermediates: true, idempotent: true });
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: true });
      const take = newTake(Crypto.randomUUID(), Date.now());
      this.current = take;
      const rec = new SegmentedRecorder({
        create: () => new AudioFile(),
        segmentMs: SEGMENT_MS,
        now: Date.now,
        // O caminho vai para a fila ANTES de gravar: se o app morrer, o trecho é achado.
        onSegmentOpen: async (uri) => {
          this.current = addPart(this.current ?? take, { uri, seconds: 0, text: null });
          await this.replace(this.current);
        },
        onSegmentClosed: async (p) => {
          const cur = this.current;
          if (!cur) return;
          this.current = { ...cur, parts: cur.parts.map((x) => (x.uri === p.uri ? { ...x, seconds: p.seconds } : x)) };
          await this.replace(this.current);
        },
      });
      await rec.start();
      this.recorder = rec;
      void activateKeepAwakeAsync("beth-recording").catch(() => undefined);
      this.levelTimer = setInterval(() => this.set({ level: meterLevel(rec.sampleLevel()) }), 150);
      this.set({ recording: { startedAt: Date.now() }, level: 0, notice: null });
      return true;
    } catch (e) {
      await this.dropCurrent();
      this.notice(`Não deu para abrir o microfone: ${e instanceof Error ? e.message : String(e)}`, true);
      return false;
    }
  }

  private stopTimers() {
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = null;
    deactivateKeepAwake("beth-recording");
    void setAudioModeAsync({ allowsRecording: false, allowsBackgroundRecording: false }).catch(() => undefined);
  }

  /** Apaga a gravação em andamento da fila e do disco. */
  private async dropCurrent() {
    const cur = this.current;
    this.current = null;
    this.recorder = null;
    if (cur) {
      for (const p of cur.parts) this.deleteFile(p.uri);
      this.set({ takes: this.snap.takes.filter((t) => t.id !== cur.id) });
      await this.persist();
    }
  }

  async cancelRecording(): Promise<void> {
    const rec = this.recorder;
    if (!rec) return;
    this.stopTimers();
    await rec.cancel().catch(() => undefined);
    await this.dropCurrent();
    this.set({ recording: null, level: 0 });
    this.notice("Gravação descartada.");
  }

  async stopRecording(): Promise<void> {
    const rec = this.recorder;
    const take = this.current;
    if (!rec || !take) return;
    this.stopTimers();
    const done = await rec.stop();
    this.recorder = null;
    this.set({ recording: null, level: 0 });
    const cur = this.current ?? take;
    this.current = null;
    // Arquivo oco não vai para a fila (é o "chooseTake" do web).
    const parts = cur.parts.filter((p) => {
      const bytes = this.sizeOf(p.uri);
      return pickRecordedFile([{ uri: p.uri, bytes }], Math.max(p.seconds, 0.2)) !== null;
    });
    const dropped = cur.parts.filter((p) => !parts.includes(p));
    dropped.forEach((p) => this.deleteFile(p.uri));
    if (parts.length === 0) {
      this.set({ takes: this.snap.takes.filter((t) => t.id !== cur.id) });
      await this.persist();
      this.notice("O microfone não entregou áudio. Tente de novo; se repetir, veja se outro app está usando o microfone.", true);
      return;
    }
    if (isSilent(done.peakDb)) {
      for (const p of parts) this.deleteFile(p.uri);
      this.set({ takes: this.snap.takes.filter((t) => t.id !== cur.id) });
      await this.persist();
      this.notice("O microfone não captou som. Veja se outro app está usando o microfone e tente de novo.", true);
      return;
    }
    await this.replace(finishRecording({ ...cur, parts }, done.seconds, Date.now()));
    void this.pump();
  }

  // ---------------------------------------------------------------- envio

  /** Confirmação de privacidade do PC (a mesma do web). `ask` mostra o aviso à pessoa. */
  async ensurePrivacy(ask: () => Promise<boolean>): Promise<boolean> {
    const api = this.api;
    if (!api) return false;
    try {
      if (await api.privacyAcked()) return true;
    } catch {
      return true; // sem conseguir perguntar ao PC, grava assim mesmo; o áudio fica guardado
    }
    if (!(await ask())) return false;
    await api.ackPrivacy().catch(() => undefined);
    return true;
  }

  private async pump(): Promise<void> {
    if (this.sending || !this.ready || !this.api) return;
    this.sending = true;
    try {
      for (;;) {
        const api = this.api;
        const next = dueTakes(this.snap.takes, Date.now())[0];
        if (!api || !next || !this.ready) break;
        const out = await processTake(next, {
          now: Date.now,
          transcribe: (uri, seconds) => api.transcribe(uri, seconds),
          save: (t) => this.replace(t),
        });
        await this.replace(out);
      }
    } finally {
      this.sending = false;
      this.armWake();
    }
  }

  private armWake() {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    const at = nextWakeAt(this.snap.takes);
    if (at === null || !this.ready) return;
    this.wakeTimer = setTimeout(() => void this.pump(), Math.max(0, at - Date.now()) + 50);
  }

  // ---------------------------------------------------------------- ações da tela

  retry(id: string) {
    const t = this.snap.takes.find((x) => x.id === id);
    if (!t || t.status !== "failed") return;
    void this.replace(manualRetry(t, Date.now())).then(() => this.pump());
  }

  discard(id: string) {
    const t = this.snap.takes.find((x) => x.id === id);
    if (!t) return;
    t.parts.forEach((p) => this.deleteFile(p.uri));
    this.set({ takes: this.snap.takes.filter((x) => x.id !== id) });
    void this.persist();
  }

  /** O texto entrou no campo do web app: agora sim apaga o áudio. */
  delivered(id: string) {
    this.discard(id);
  }

  async sharePart(id: string, index: number): Promise<void> {
    const uri = this.snap.takes.find((x) => x.id === id)?.parts[index]?.uri;
    if (!uri) return;
    try {
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: "audio/mp4", dialogTitle: "Salvar áudio" });
      else this.notice("Este aparelho não tem como compartilhar arquivos.", true);
    } catch (e) {
      this.notice(`Não deu para baixar o áudio: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  // ---------------------------------------------------------------- disco

  private sizeOf(uri: string): number {
    try {
      const f = new File(uri);
      return f.exists ? f.size : 0;
    } catch {
      return 0;
    }
  }

  private deleteFile(uri: string) {
    try {
      const f = new File(uri);
      if (f.exists) f.delete();
    } catch {
      /* já apagado */
    }
  }
}

export const voice = new VoiceService();
