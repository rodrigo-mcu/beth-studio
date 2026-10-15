import type { PaneInfo, ScreenEvent, ServerEvent, SettingsEvent, ShellInfo, SocketState, SpawnedEvent, StatusEvent } from "./types";
import { applyAgent, Pending, requestIdFromError, type AgentState } from "./agents";
import { apiBase } from "./remote";
import type { TermDragEvent } from "./termDrop";
import type { HostEvent } from "./hostBanner";
import type { RestoreEvent } from "./restoreBanner";

// Conexao WebSocket com o backend Go. Um unico socket por pagina; as telas
// (screen) vao direto para os assinantes de cada pane, sem passar pelo
// estado do React (chegam a cada ~30 ms).

type ScreenListener = (ev: ScreenEvent) => void;

export interface ConnectionSnapshot {
  socket: SocketState;
  status: StatusEvent | null;
  panes: PaneInfo[] | null;
  lastError: string | null;
  settings: SettingsEvent | null;
  /** panes com agente aguardando o usuario (patch 0175) */
  agents: AgentState;
  shells: ShellInfo[] | null;
  /** panes que estao em janela destacada (nativa) */
  termWindows: number[];
  /** estado do host visto pelo supervisor do Studio (null = ainda sem informacao) */
  host: HostEvent | null;
  /** restauracao dos terminais depois de uma queda (null = nenhuma) */
  restore: RestoreEvent | null;
  /** quando a restauracao terminou (ms; 0 = nao terminou) */
  restoreFinishedAt: number;
}

function readParams() {
  const q = new URLSearchParams(window.location.search);
  const token = q.get("t") ?? "";
  // `api` so' e' usado no `vite dev` (a UI roda em outra porta). No Studio
  // remoto as rotas ficam em /studio (remote.ts).
  const api = q.get("api") ?? window.location.host + apiBase();
  if (token && !q.get("api")) {
    // Tira o token da barra de endereco; o cookie (HttpOnly) cobre reloads.
    q.delete("t");
    const rest = q.toString();
    window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : ""));
  }
  return { token, api };
}

export class Connection {
  private ws: WebSocket | null = null;
  private token: string;
  private apiHost: string;
  private backoff = 500;
  private timer: number | undefined;
  private disposed = false;
  private watched: number[] = [];
  /** Offset de rolagem pedido por pane (reenviado ao reconectar). */
  private offsets = new Map<number, number>();
  private screenListeners = new Map<number, Set<ScreenListener>>();
  private lastScreens = new Map<number, ScreenEvent>();
  private snapshot: ConnectionSnapshot = {
    socket: "connecting",
    status: null,
    panes: null,
    lastError: null,
    settings: null,
    agents: {},
    shells: null,
    termWindows: [],
    host: null,
    restore: null,
    restoreFinishedAt: 0,
  };
  private spawns = new Pending<SpawnedEvent>();
  private separations = new Pending<number>();
  private errorListeners = new Set<(msg: string) => void>();
  private termDragListeners = new Set<(e: TermDragEvent) => void>();
  private uiOpenListeners = new Set<(what: string) => void>();

  /** A bandeja pede para abrir uma tela do Studio (ex.: o gerenciador de tarefas). */
  onUiOpen(fn: (what: string) => void) {
    this.uiOpenListeners.add(fn);
    return () => {
      this.uiOpenListeners.delete(fn);
    };
  }

  /** Arrasto de uma janela de terminal destacada (posicao ja em pixels do Studio). */
  onTermDrag(fn: (e: TermDragEvent) => void) {
    this.termDragListeners.add(fn);
    return () => {
      this.termDragListeners.delete(fn);
    };
  }

  /** Erros da ponte (para quem precisa reagir, ex. resize recusado). */
  onBridgeError(fn: (msg: string) => void) {
    this.errorListeners.add(fn);
    return () => {
      this.errorListeners.delete(fn);
    };
  }
  private reqSeq = 0;
  private listeners = new Set<() => void>();

  constructor() {
    const p = readParams();
    this.token = p.token;
    this.apiHost = p.api;
    this.connect();
  }

  private httpProto() {
    return window.location.protocol === "https:" ? "https:" : "http:";
  }

  private wsProto() {
    return window.location.protocol === "https:" ? "wss:" : "ws:";
  }

  // --- estado para o React (useSyncExternalStore) ---
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.snapshot;
  private patch(p: Partial<ConnectionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...p };
    this.listeners.forEach((fn) => fn());
  }

  private connect() {
    if (this.disposed) return;
    this.patch({ socket: "connecting" });
    const url = `${this.wsProto()}//${this.apiHost}/ws` + (this.token ? `?t=${encodeURIComponent(this.token)}` : "");
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      // o Go reenvia o estado atual dos agentes logo apos conectar
      this.patch({ socket: "open", agents: {} });
      this.raw({ op: "list" });
      void this.api<{ panes: number[] }>("/api/term/list")
        .then((r) => this.patch({ termWindows: r.panes ?? [] }))
        .catch(() => {});
      if (this.watched.length) this.raw({ op: "watch", pane_ids: this.watched });
      for (const [pane_id, offset] of this.offsets) if (offset > 0) this.raw({ op: "scroll", pane_id, offset });
    };
    ws.onmessage = (m) => {
      let ev: ServerEvent;
      try {
        ev = JSON.parse(m.data as string);
      } catch {
        return;
      }
      switch (ev.ev) {
        case "screen": {
          const s = ev;
          this.lastScreens.set(s.pane_id, s);
          this.screenListeners.get(s.pane_id)?.forEach((fn) => fn(s));
          break;
        }
        case "list":
          this.patch({ panes: ev.panes });
          break;
        case "status": {
          // ponte pronta: some qualquer aviso antigo de conexao/ponte
          const stale = ev.state === "up" && /ponte|Beth Studio|conect|indispon/i.test(this.snapshot.lastError ?? "");
          this.patch(stale ? { status: ev, lastError: null } : { status: ev });
          break;
        }
        case "agent":
          this.patch({ agents: applyAgent(this.snapshot.agents, ev) });
          break;
        case "shells":
          this.patch({ shells: ev.shells });
          break;
        case "pane_gone": {
          // Patch 0179: terminal fechado no host. Sai da lista na hora (a
          // folha dele vira "terminal encerrado" com Remover).
          const id = ev.pane_id;
          this.lastScreens.delete(id);
          this.patch({
            panes: this.snapshot.panes ? this.snapshot.panes.filter((p) => p.pane_id !== id) : null,
            agents: applyAgent(this.snapshot.agents, { ev: "agent", pane_id: id, waiting: false, reason: "gone" }),
          });
          break;
        }
        case "error": {
          const rid = requestIdFromError(ev.message);
          if (rid && this.spawns.reject(rid, new Error(ev.message))) break;
          const sep = /^separate:? (?:pane )?(\d+)/.exec(ev.message);
          if (sep && this.separations.reject(sep[1], new Error(ev.message))) break;
          if (/no such pane/i.test(ev.message)) break; // ponte antiga: terminal fechado
          this.errorListeners.forEach((fn) => fn(ev.message));
          // recusa de resize (pane em split no host): o terminal cai sozinho
          // para "Igual ao Beth Studio", sem faixa de erro
          if (/^resize: pane \d+ shares its Beth Studio tab/.test(ev.message)) break;
          this.patch({ lastError: ev.message });
          break;
        }
        case "separated":
          this.separations.resolve(String(ev.pane_id), ev.pane_id);
          break;
        case "spawned":
          if (ev.request_id) this.spawns.resolve(ev.request_id, ev);
          break;
        case "settings":
          this.patch({ settings: ev });
          break;
        case "term_windows":
          this.patch({ termWindows: ev.panes });
          break;
        case "host":
          this.patch({ host: ev });
          break;
        case "restore":
          this.patch({ restore: ev, restoreFinishedAt: ev.stage === "finished" ? Date.now() : 0 });
          break;
        case "ui_open":
          if (ev.what === "reload") {
            window.location.reload();
            break;
          }
          this.uiOpenListeners.forEach((fn) => fn(ev.what));
          break;
        case "term_drag":
          this.termDragListeners.forEach((fn) => fn({ pane: ev.pane, x: ev.x, y: ev.y, end: ev.end, attach: ev.attach }));
          break;
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.patch({ socket: "closed" });
      if (this.disposed) return;
      this.timer = window.setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 5000);
    };
  }

  dispose() {
    this.disposed = true;
    window.clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private raw(obj: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  /** fetch na API do backend (mesma origem; token no header se houver). */
  /** Envia bytes crus (imagem/arquivo colado) para a API. */
  async upload<T>(path: string, body: Blob, contentType: string, opts?: { signal?: AbortSignal; headers?: Record<string, string> }): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": contentType, ...(opts?.headers ?? {}) };
    if (this.token) headers["X-BethStudio-Token"] = this.token;
    const r = await fetch(`${this.httpProto()}//${this.apiHost}${path}`, { method: "POST", headers, credentials: "include", body, signal: opts?.signal });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      // outros campos do corpo (ex. "kind", classificado pelo Go) vao junto,
      // para quem chamou decidir o que oferecer (tentar de novo, configurar…)
      throw Object.assign(new Error((data as { error?: string }).error || `HTTP ${r.status}`), data);
    }
    return data as T;
  }

  async api<T>(path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers["X-BethStudio-Token"] = this.token;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const r = await fetch(`${this.httpProto()}//${this.apiHost}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      credentials: "include",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    // status junto: quem chama distingue, ex., o 409 de conflito do editor de arquivo
    if (!r.ok) throw Object.assign(new Error((data as { error?: string }).error || `HTTP ${r.status}`), { status: r.status });
    return data as T;
  }

  /** GET binario (ex. audio de exemplo): corpo e cabecalhos. */
  async getBlob(path: string, signal?: AbortSignal): Promise<{ blob: Blob; headers: Headers }> {
    const headers: Record<string, string> = {};
    if (this.token) headers["X-BethStudio-Token"] = this.token;
    const r = await fetch(`${this.httpProto()}//${this.apiHost}${path}`, { headers, credentials: "include", signal });
    if (!r.ok) {
      // erros amigaveis (ex. /api/local-file) vem como JSON {"error":"..."}
      const data = await r.json().catch(() => null as { error?: string } | null);
      throw new Error(data?.error || `HTTP ${r.status}`);
    }
    return { blob: await r.blob(), headers: r.headers };
  }

  /** POST JSON cuja resposta chega aos poucos (NDJSON): devolve o Response. */
  async postStream(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) headers["X-BethStudio-Token"] = this.token;
    const r = await fetch(`${this.httpProto()}//${this.apiHost}${path}`, { method: "POST", headers, credentials: "include", body: JSON.stringify(body), signal });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
    }
    return r;
  }

  /** Aplica uma resposta de /api/settings/... ao estado. */
  setSettings(s: SettingsEvent) {
    this.patch({ settings: { ...s, ev: "settings" } });
  }

  reconnectNow() {
    window.clearTimeout(this.timer);
    this.backoff = 500;
    if (!this.ws) this.connect();
  }

  refreshList() {
    this.raw({ op: "list" });
  }

  clearError() {
    this.patch({ lastError: null });
  }

  /** Substitui o conjunto de panes observados desta pagina. */
  setWatched(ids: number[]) {
    const next = [...new Set(ids)].sort((a, b) => a - b);
    if (next.join(",") === this.watched.join(",")) return;
    this.watched = next;
    for (const id of [...this.lastScreens.keys()]) if (!next.includes(id)) this.lastScreens.delete(id);
    for (const id of [...this.offsets.keys()]) if (!next.includes(id)) this.offsets.delete(id);
    this.raw({ op: "watch", pane_ids: next });
  }

  /** Pede uma fotografia nova ao bridge, sem escrever no terminal. */
  refreshScreen(paneId: number) {
    if (this.watched.includes(paneId)) this.raw({ op: "watch", pane_ids: this.watched });
  }

  /** Texto SGR da ultima tela recebida (so' panes observados). */
  lastScreenText(paneId: number): string | undefined {
    return this.lastScreens.get(paneId)?.text;
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

  /** Redimensiona o pane NO HOST (so' panes sozinhos na aba do host). */
  resize(paneId: number, cols: number, rows: number) {
    return this.raw({ op: "resize", pane_id: paneId, cols, rows });
  }

  /** Tira o pane do split no host (aba propria na mesma janela; patch 0182). */
  separate(paneId: number): Promise<number> {
    const p = this.separations.add(String(paneId), 15000);
    if (!this.raw({ op: "separate", pane_id: paneId })) this.separations.reject(String(paneId), new Error("sem conexão"));
    return p;
  }

  /** Encerra o processo do terminal (so' via lib/killFlow.ts, apos confirmar). */
  kill(paneId: number) {
    return this.raw({ op: "kill", pane_id: paneId });
  }

  requestShells() {
    this.raw({ op: "shells" });
  }

  /** Terminal de ferramenta no host (SSH salvo / porta serial): a ponte monta
   *  o comando `bethstudio-tool.exe --ssh|--serial <id>`; espera o `spawned`. */
  spawnTool(opts: { kind: "ssh" | "serial"; id: string; window_id?: number }): Promise<SpawnedEvent> {
    const request_id = `w${Date.now().toString(36)}${(this.reqSeq++).toString(36)}`;
    const p = this.spawns.add(request_id, 20000);
    const req: Record<string, unknown> = { op: "spawn_tool", kind: opts.kind, id: opts.id, request_id };
    if (opts.window_id !== undefined) req.window_id = opts.window_id;
    if (!this.raw(req)) this.spawns.reject(request_id, new Error("sem conexão"));
    return p;
  }

  /** Cria um terminal no host (ponte patch 0176) e espera o `spawned`. */
  spawn(opts: { shell_id: string; window_id?: number; cwd?: string }): Promise<SpawnedEvent> {
    const request_id = `w${Date.now().toString(36)}${(this.reqSeq++).toString(36)}`;
    const p = this.spawns.add(request_id, 20000);
    const req: Record<string, unknown> = { op: "spawn", shell_id: opts.shell_id, request_id };
    if (opts.window_id !== undefined) req.window_id = opts.window_id;
    if (opts.cwd) req.cwd = opts.cwd;
    if (!this.raw(req)) this.spawns.reject(request_id, new Error("sem conexão"));
    return p;
  }

  /** "Dispensar" o aviso de agente aguardando (so' na interface). */
  dismissAgent(pane: number) {
    this.raw({ op: "dismiss_agent", pane_id: pane });
    this.patch({ agents: applyAgent(this.snapshot.agents, { ev: "agent", pane_id: pane, waiting: false, reason: "dismissed" }) });
  }

  /** Mostra `offset` linhas acima da tela viva (0 = ao vivo). */
  scroll(paneId: number, offset: number) {
    const o = Math.max(0, Math.min(1_000_000, Math.round(offset)));
    this.offsets.set(paneId, o);
    return this.raw({ op: "scroll", pane_id: paneId, offset: o });
  }

  /** Bytes crus para o pane (teclado). A ponte volta a rolagem para o fim. */
  send(paneId: number, data: string) {
    if (!data) return false;
    this.offsets.set(paneId, 0);
    return this.raw({ op: "send", pane_id: paneId, data });
  }

  /** Texto colado (o host aplica bracketed paste se o programa pediu). */
  paste(paneId: number, data: string) {
    if (!data) return false;
    this.offsets.set(paneId, 0);
    return this.raw({ op: "paste", pane_id: paneId, data });
  }
}
