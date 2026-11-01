// Microfone: tipos, chamadas a' API do Go e funcoes puras (testadas em
// tests/voice.test.ts). As chaves nunca passam por aqui depois de salvas.

import type { Connection } from "./connection";

export interface ProviderPrefs {
  base_url?: string;
  audio_url?: string;
  api_version?: string;
  stt_models?: string[];
  llm_models?: string[];
  /** DeepInfra: rota da transcricao ("" = nativa, o padrao; "openai" = OpenAI-compativel) */
  route?: string;
}

export interface VoiceSettings {
  stt_provider: string;
  stt_model: string;
  language: string;
  llm_enabled: boolean;
  llm_provider: string;
  llm_model: string;
  prompt: string;
  vocabulary: string;
  prefix_enabled?: boolean;
  prefix_text: string;
  send_direct: boolean;
  privacy_ack: boolean;
  /** microfone escolhido ("" = padrao do Windows) */
  mic_device_id?: string;
  mic_label?: string;
  /** prazo da correcao em s (0/ausente = 30) */
  correct_timeout_sec?: number;
  /** alerta de gasto mensal com IA em US$ (0 = sem alerta) */
  monthly_limit_usd?: number;
  /** mostrar a correcao enquanto chega (padrao: nao) */
  show_correction_stream?: boolean;
  /** vocabulario tecnico padrao junto do vocabulario do usuario (ausente = ligado) */
  tech_vocab?: boolean;
  /** assistente de SQL no Banco de dados (modelo próprio, mesma chave dos provedores) */
  db_assist_enabled?: boolean;
  db_assist_provider?: string;
  db_assist_model?: string;
  providers?: Record<string, ProviderPrefs>;
}

export interface ProviderView {
  id: string;
  name: string;
  kind: string;
  base_url: string;
  audio_url?: string;
  keys_url?: string;
  stt: boolean;
  llm: boolean;
  stt_models?: string[];
  llm_models?: string[];
  needs_key: boolean;
  models_list: boolean;
  local?: boolean;
  edit_url?: boolean;
  notes?: string;
  /** "device": login por código, sem colar chave */
  login?: string;
  prefs: ProviderPrefs;
  configured: boolean;
  masked?: string;
  key_source?: string;
}

export interface VoiceSnapshot {
  settings: VoiceSettings;
  providers: ProviderView[];
  default_prompt: string;
  default_prefix: string;
  default_vocabulary: string;
}

// --- API ---------------------------------------------------------------

/** Acima disto o Falar não cola o texto: grava num arquivo e cola só uma instrução (alguns agentes recusam colagem enorme). */
export const LONG_PASTE_WORDS = 100;
export const LONG_PASTE_CHARS = 1000;
export const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
export const isLongPaste = (msg: string) => msg.length > LONG_PASTE_CHARS || wordCount(msg) > LONG_PASTE_WORDS;
export const pasteAsFile = (conn: Connection, pane: number, text: string) =>
  conn.api<{ path: string; text: string }>("/api/paste-text", { pane_id: pane, text });

export const loadVoice =(conn: Connection) => conn.api<VoiceSnapshot>("/api/voice");
export const saveVoice = (conn: Connection, v: VoiceSettings) => conn.api<VoiceSnapshot>("/api/voice/settings", v);
export const saveKey = (conn: Connection, provider: string, key: string) => conn.api<VoiceSnapshot>("/api/voice/key", { provider, key });

export interface DeviceStart {
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

export const startAccountLogin = (conn: Connection, provider: string) =>
  conn.api<DeviceStart>("/api/voice/account/start", { provider });
export const pollAccountLogin = (conn: Connection, provider: string) =>
  conn.api<VoiceSnapshot & { status?: string }>("/api/voice/account/poll", { provider });
export const logoutAccount = (conn: Connection, provider: string) =>
  conn.api<VoiceSnapshot>("/api/voice/account/logout", { provider });
export const testProvider = (conn: Connection, provider: string) => conn.api<{ message: string }>("/api/voice/test", { provider });
export const fetchModels = (conn: Connection, provider: string) => conn.api<{ models: string[] }>("/api/voice/models", { provider });
export const openKeysPage = (conn: Connection, provider: string) => conn.api<{ url: string }>("/api/voice/open-keys", { provider });
export const correctText = (conn: Connection, text: string) => conn.api<{ text: string; ms: number }>("/api/voice/correct", { text });

export function transcribeAudio(conn: Connection, audio: Blob) {
  return conn.upload<{ text: string; ms: number; provider: string; model: string }>(
    "/api/voice/transcribe",
    audio,
    audio.type || "audio/webm",
  );
}

// --- texto ----------------------------------------------------------------

/**
 * Texto que vai para o agente: prefixo "ditado por voz" (se ligado) numa
 * linha, depois o texto. Colado com `paste` (bracketed): a quebra de linha
 * nao vira Enter no agente, e NUNCA ha' Enter no fim — o usuario revisa no
 * proprio agente e aperta Enter.
 */
export function composeMessage(prefixEnabled: boolean, prefix: string, text: string): string {
  const body = sanitizePaste(text);
  const p = sanitizePaste(prefix);
  return prefixEnabled && p ? `${p}\n${body}` : body;
}

/** Sem \r, sem quebra/espaco no fim (nada de Enter final). */
export function sanitizePaste(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(/[\s ]+$/u, "").replace(/^\n+/, "");
}

export interface DiffPart {
  text: string;
  kind: "same" | "added" | "removed";
}

/** Diferenca por palavras (LCS) para destacar o que a correcao mudou. */
export function wordDiff(original: string, corrected: string): DiffPart[] {
  const a = original.split(/(\s+)/).filter((x) => x !== "");
  const b = corrected.split(/(\s+)/).filter((x) => x !== "");
  if (a.length * b.length > 4_000_000) return [{ text: corrected, kind: "same" }];
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffPart[] = [];
  const push = (text: string, kind: DiffPart["kind"]) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ text, kind });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(a[i], "same");
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) push(a[i++], "removed");
    else push(b[j++], "added");
  }
  while (i < a.length) push(a[i++], "removed");
  while (j < b.length) push(b[j++], "added");
  return out;
}

/** Trechos ambiguos que a correcao marcou com [? ...]. */
export function ambiguousSpans(text: string): string[] {
  return [...text.matchAll(/\[\?\s*([^\]]*)\]/g)].map((m) => m[1].trim());
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const MAX_RECORD_MS = 10 * 60 * 1000;

export const LANGUAGES: { id: string; label: string }[] = [
  { id: "pt", label: "Português" },
  { id: "auto", label: "Detectar automaticamente" },
  { id: "en", label: "Inglês" },
  { id: "es", label: "Espanhol" },
];

/** Mensagem amigavel para erros do getUserMedia. */
export function micErrorMessage(name: string): string {
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "O microfone foi bloqueado. No Windows: Configurações → Privacidade e segurança → Microfone → ligue “Acesso ao microfone” e “Permitir que aplicativos da área de trabalho acessem o microfone”.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "Nenhum microfone encontrado. Conecte um microfone e tente de novo.";
    case "NotReadableError":
      return "O microfone está em uso por outro programa ou indisponível.";
    case "TimeoutError":
      return "O Windows não respondeu ao abrir o microfone. Feche e abra o Falar de novo; se repetir, desligue e ligue o microfone nas configurações de som do Windows.";
  }
  return "Não foi possível abrir o microfone.";
}
