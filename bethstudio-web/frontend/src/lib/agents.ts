// "Agente aguardando" (patch 0175) e criacao de terminais (patch 0176):
// funcoes puras testadas em tests/agents.test.ts.

import { wslFromUNC } from "./folderBrowser.ts";

export interface AgentEvent {
  ev: "agent";
  pane_id: number;
  waiting: boolean;
  reason: string; // bell | toast | user_var | input | dismissed
  detail?: string;
}

export interface AgentInfo {
  pane: number;
  reason: string;
  detail: string;
  since: number;
}

export type AgentState = Record<number, AgentInfo>;

/** Aplica um evento: waiting:true marca (mantendo o "desde"), false limpa. */
export function applyAgent(state: AgentState, ev: AgentEvent, now = Date.now()): AgentState {
  if (ev.waiting) {
    const prev = state[ev.pane_id];
    return { ...state, [ev.pane_id]: { pane: ev.pane_id, reason: ev.reason, detail: ev.detail ?? "", since: prev?.since ?? now } };
  }
  if (!(ev.pane_id in state)) return state;
  const next = { ...state };
  delete next[ev.pane_id];
  return next;
}

/** Panes aguardando que ainda existem no host, o mais antigo primeiro. */
export function waitingList(state: AgentState, alive?: Set<number>): AgentInfo[] {
  return Object.values(state)
    .filter((a) => !alive || alive.has(a.pane))
    .sort((a, b) => a.since - b.since || a.pane - b.pane);
}

export function reasonLabel(a: AgentInfo): string {
  const r: Record<string, string> = {
    bell: "sino",
    toast: "notificação",
    user_var: "status do agente",
  };
  const base = r[a.reason] ?? a.reason;
  return a.detail ? `${base}: ${a.detail}` : base;
}

/** Tira o request_id de um erro da ponte: "spawn x (request r1): ...". */
export function requestIdFromError(message: string): string | null {
  const m = /\(request ([A-Za-z0-9_-]+)\)/.exec(message);
  return m ? m[1] : null;
}

/** Pedidos com resposta assincrona, correlacionados por id. */
export class Pending<T> {
  private map = new Map<string, { resolve: (v: T) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  add(id: string, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.map.delete(id);
        reject(new Error("sem resposta do Beth Studio"));
      }, timeoutMs);
      this.map.set(id, { resolve, reject, timer });
    });
  }

  resolve(id: string, v: T): boolean {
    const p = this.map.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.map.delete(id);
    p.resolve(v);
    return true;
  }

  reject(id: string, e: Error): boolean {
    const p = this.map.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.map.delete(id);
    p.reject(e);
    return true;
  }

  get size() {
    return this.map.size;
  }
}

export type ShellKind = "powershell" | "cmd" | "wsl" | "gitbash" | "ssh" | "log" | "other";

export function shellKind(id: string): ShellKind {
  if (id === "powershell" || id === "pwsh" || id.startsWith("powershell") || id.startsWith("pwsh")) return "powershell";
  if (id === "cmd") return "cmd";
  if (id.startsWith("wsl")) return "wsl";
  if (id.startsWith("gitbash") || id.startsWith("git")) return "gitbash";
  if (id.startsWith("mobaxterm") || id.startsWith("ssh")) return "ssh";
  if (/(^|\.)(log|debug)(\.|$)/.test(id)) return "log"; // ex. "app.debug"
  return "other";
}

/**
 * Pasta inicial para um shell a partir do cwd (file://host/caminho) do
 * terminal em foco. Windows <-> WSL so' pelas regras conhecidas
 * (C:\x <-> /mnt/c/x); o resto fica vazio (o shell usa a pasta dele).
 */
export function spawnCwd(cwdUri: string, shellId: string): string {
  if (!cwdUri) return "";
  let path = cwdUri;
  if (path.startsWith("file://")) {
    const rest = path.slice(7);
    const i = rest.indexOf("/");
    path = i >= 0 ? rest.slice(i) : "";
    try {
      path = decodeURIComponent(path);
    } catch {
      /* mantem */
    }
  }
  path = path.replace(/\/+$/, "") || path;
  const kind = shellKind(shellId);
  const winDrive = /^\/([A-Za-z]):(\/.*)?$/.exec(path); // /C:/x
  const mnt = /^\/mnt\/([a-z])(\/.*)?$/.exec(path); // /mnt/c/x
  if (kind === "wsl") {
    if (winDrive) return `/mnt/${winDrive[1].toLowerCase()}${winDrive[2] ?? ""}`;
    return path.startsWith("/") ? path : "";
  }
  if (kind === "log" || kind === "ssh" || kind === "other") return "";
  if (winDrive) return `${winDrive[1].toUpperCase()}:${(winDrive[2] ?? "\\").replace(/\//g, "\\")}`;
  if (mnt) return `${mnt[1].toUpperCase()}:${(mnt[2] ?? "\\").replace(/\//g, "\\")}`;
  return "";
}

/** Onde o seletor de pasta do Windows deve abrir. Vazio = o Windows escolhe. */
export function explorerStart(cwd: string): string {
  const t = cwd.trim();
  if (!t) return "";
  if (/^[A-Za-z]:[\\/]/.test(t) || t.startsWith("\\\\")) return t;
  const m = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(t);
  if (!m) return "";
  const rest = (m[2] ?? "").replace(/\//g, "\\");
  return `${m[1].toUpperCase()}:${rest || "\\"}`;
}

/** Pasta escolhida no Explorer, no formato que o shell entende. */
export function cwdFromPickedFolder(winPath: string, shellId: string): string {
  const p = winPath.trim();
  if (shellKind(shellId) !== "wsl") return p;
  // Pasta de dentro do Linux (\\wsl.localhost\<distro>\home\...): o shell WSL usa /home/...
  const unc = wslFromUNC(p);
  if (unc) return unc.path;
  const m = /^([A-Za-z]):\\?(.*)$/.exec(p);
  if (!m) return p;
  const rest = m[2].replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const asFile = rest ? `/${m[1]}:/${rest}` : `/${m[1]}:/`;
  return spawnCwd(`file://localhost${asFile}`, shellId);
}
