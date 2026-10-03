import { buildRequest, parseServerEvent } from "./parse";
import type { ClientRequest, PaneInfo, ScreenEvent, SocketState, StatusEvent } from "./types";
import { parseServerUrl, type ServerEndpoint } from "./url";

// Cliente do protocolo WS do bethstudio-web. Um socket por conexao salva.
// As telas (`screen`, ~30 ms) vao direto aos assinantes de cada pane, sem
// passar pelo estado do React.

export const TOKEN_HEADER = "X-BethStudio-Token";

/** O minimo de WebSocket que o cliente usa (RN, `ws` do Node ou um fake). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}

export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike;

const WS_OPEN = 1;

/**
 * Fabrica padrao: WebSocket do React Native, que aceita headers no 3o
 * argumento. O token vai no header, nunca na URL (URLs acabam em logs).
 */
export const defaultWebSocketFactory: WebSocketFactory = (url, headers) => {
  const Ctor = globalThis.WebSocket as unknown as new (
    u: string,
    p?: string[] | null,
    o?: { headers: Record<string, string> },
  ) => WebSocketLike;
  return new Ctor(url, null, { headers });
};

export interface ClientSnapshot {
  socket: SocketState;
  status: StatusEvent | null;
  panes: PaneInfo[] | null;
  lastError: string | null;
  /** Momento da ultima lista recebida (para o "puxar para atualizar"). */
  listAt: number;
  /** Somente leitura efetivo (local OU imposto pelo servidor). */
  readOnly: boolean;
}

export interface ClientOptions {
  url: string;
  token: string;
  /** Somente leitura local: send/paste nunca saem do app. */
  readOnly: boolean;
  factory?: WebSocketFactory;
  /** Reconectar sozinho ao cair (padrao true). */
  reconnect?: boolean;
  maxBackoffMs?: number;
}

type ScreenListener = (ev: ScreenEvent) => void;

export class ProtocolClient {
  readonly endpoint: ServerEndpoint;
  private readonly token: string;
  private readonly factory: WebSocketFactory;
  private readonly reconnect: boolean;
  private readonly maxBackoff: number;
  private localReadOnly: boolean;
  private ws: WebSocketLike | null = null;
  private backoff = 500;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private watched: number[] = [];
  private offsets = new Map<number, number>();
  private screenListeners = new Map<number, Set<ScreenListener>>();
  private lastScreens = new Map<number, ScreenEvent>();
  private listeners = new Set<() => void>();
  private snapshot: ClientSnapshot;

  constructor(opts: ClientOptions) {
    this.endpoint = parseServerUrl(opts.url);
    this.token = opts.token;
    this.localReadOnly = opts.readOnly;
    this.factory = opts.factory ?? defaultWebSocketFactory;
    this.reconnect = opts.reconnect ?? true;
    this.maxBackoff = opts.maxBackoffMs ?? 10_000;
    this.snapshot = { socket: "idle", status: null, panes: null, lastError: null, listAt: 0, readOnly: opts.readOnly };
  }

  // --- estado para o React (useSyncExternalStore) ---
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.snapshot;
  private patch(p: Partial<ClientSnapshot>) {
    const next = { ...this.snapshot, ...p };
    next.readOnly = this.localReadOnly || next.status?.read_only === true;
    this.snapshot = next;
    this.listeners.forEach((fn) => fn());
  }

  get isReadOnly(): boolean {
    return this.snapshot.readOnly;
  }

  setReadOnly(v: boolean) {
    this.localReadOnly = v;
    this.patch({});
  }

  /** Abre o socket (e reabre sozinho ao cair). */
  start() {
    if (this.running) return;
    this.running = true;
    this.backoff = 500;
    this.connect();
  }

  /** Fecha o socket e para de reconectar (app em segundo plano, tela fechada). */
  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, "");
    this.patch({ socket: "idle" });
  }

  reconnectNow() {
    if (!this.running) {
      this.start();
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    this.backoff = 500;
    if (!this.ws) this.connect();
  }

  private connect() {
    if (!this.running) return;
    this.patch({ socket: "connecting" });
    let ws: WebSocketLike;
    try {
      ws = this.factory(this.endpoint.wsUrl, { [TOKEN_HEADER]: this.token, Origin: this.endpoint.origin });
    } catch (e) {
      this.patch({ socket: "closed", lastError: e instanceof Error ? e.message : String(e) });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    let opened = false;
    let failure: string | null = null;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      opened = true;
      this.backoff = 500;
      this.patch({ socket: "open", lastError: null });
      this.raw({ op: "list" });
      if (this.watched.length) this.raw({ op: "watch", pane_ids: this.watched });
      for (const [pane_id, offset] of this.offsets) if (offset > 0) this.raw({ op: "scroll", pane_id, offset });
    };
    ws.onmessage = (m) => {
      if (this.ws !== ws || typeof m.data !== "string") return;
      this.handleMessage(m.data);
    };
    ws.onerror = (e) => {
      // O onclose vem em seguida; guarda o motivo (RN poe em `message`).
      const m = (e as { message?: unknown } | null)?.message;
      if (typeof m === "string" && m) failure = m;
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.patch(!opened && failure ? { socket: "closed", lastError: describeFailure(failure) } : { socket: "closed" });
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (!this.running || !this.reconnect) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
  }

  /** Processa uma mensagem de texto do servidor (publico para testes). */
  handleMessage(data: string) {
    const ev = parseServerEvent(data);
    if (!ev) return;
    switch (ev.ev) {
      case "screen":
        if (!this.watched.includes(ev.pane_id)) return;
        this.lastScreens.set(ev.pane_id, ev);
        this.screenListeners.get(ev.pane_id)?.forEach((fn) => fn(ev));
        break;
      case "list":
        this.patch({ panes: ev.panes, listAt: Date.now() });
        break;
      case "status":
        this.patch({ status: ev });
        break;
      case "error":
        this.patch({ lastError: ev.message });
        break;
    }
  }

  private raw(req: ClientRequest): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return false;
    ws.send(buildRequest(req));
    return true;
  }

  refreshList() {
    return this.raw({ op: "list" });
  }

  clearError() {
    this.patch({ lastError: null });
  }

  /** Substitui o conjunto de panes observados (o servidor aceita ate 16). */
  setWatched(ids: number[]) {
    const next = [...new Set(ids)].sort((a, b) => a - b);
    if (next.join(",") === this.watched.join(",")) return;
    this.watched = next;
    for (const id of [...this.lastScreens.keys()]) if (!next.includes(id)) this.lastScreens.delete(id);
    for (const id of [...this.offsets.keys()]) if (!next.includes(id)) this.offsets.delete(id);
    this.raw({ op: "watch", pane_ids: next });
  }

  onScreen(paneId: number, fn: ScreenListener) {
    let set = this.screenListeners.get(paneId);
    if (!set) {
      set = new Set();
      this.screenListeners.set(paneId, set);
    }
    set.add(fn);
    const last = this.lastScreens.get(paneId);
    if (last) fn(last);
    return () => {
      set.delete(fn);
    };
  }

  /** Mostra `offset` linhas acima da tela viva (0 = ao vivo). Permitido em somente leitura. */
  scroll(paneId: number, offset: number) {
    const o = Math.max(0, Math.min(1_000_000, Math.round(offset)));
    this.offsets.set(paneId, o);
    return this.raw({ op: "scroll", pane_id: paneId, offset: o });
  }

  /** Bytes crus (teclado). Em somente leitura nunca sai do app. */
  send(paneId: number, data: string): boolean {
    if (this.isReadOnly || !data) return false;
    this.offsets.set(paneId, 0);
    return this.raw({ op: "send", pane_id: paneId, data });
  }

  /** Texto colado (o host aplica bracketed paste). Em somente leitura nunca sai do app. */
  paste(paneId: number, data: string): boolean {
    if (this.isReadOnly || !data) return false;
    this.offsets.set(paneId, 0);
    return this.raw({ op: "paste", pane_id: paneId, data });
  }
}

/** Mensagem do handshake recusado -> texto para a pessoa. */
export function describeFailure(msg: string): string {
  if (/\b401\b/.test(msg)) return "O servidor recusou o token.";
  if (/\b403\b/.test(msg)) return "O servidor recusou esta conexão (endereço ou origem não permitidos).";
  if (/\b404\b/.test(msg)) return "Endereço encontrado, mas não é um servidor Beth Studio (caminho /ws).";
  if (/cert|ssl|tls|handshake/i.test(msg)) return "Falha no certificado TLS do servidor.";
  return `Não foi possível conectar: ${msg}`;
}
