// API das telas SSH e Serial (ssh_api.go, ssh_net_api.go, sftp_api.go,
// serial_api.go). Senhas digitadas agora vao so' no corpo da requisicao
// (ou no cabecalho, no upload) e nunca voltam; a resposta so' diz se ha'
// credencial salva (has_password / has_passphrase).
import { isRemote, openRemoteTab } from "./remote.ts";

export type SshAuth = "password" | "key" | "agent";

export interface SshHost {
  id: string;
  name: string;
  group?: string;
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  key_path?: string;
  color?: string;
  tag?: string;
  notes?: string;
  initial_dir?: string;
  created_at?: string;
  updated_at?: string;
  has_password: boolean;
  has_passphrase: boolean;
}

export interface SshRecent {
  id: string;
  at: string;
}

export interface SshHostKeyInfo {
  addr: string;
  key_type: string;
  fingerprint: string;
  known_fingerprints?: string[];
  mismatch: boolean;
}

export interface SshTestResult {
  ok: boolean;
  code?: "unknown_host_key" | "host_key_mismatch" | "auth" | "error";
  error?: string;
  host_key?: SshHostKeyInfo;
  trusted?: boolean;
}

export interface SshConfigCandidate {
  alias: string;
  host: SshHost;
  exists: boolean;
  warnings?: string[];
}

export interface SftpEntry {
  name: string;
  size: number;
  is_dir: boolean;
  is_link: boolean;
  mode: string;
  mtime: number;
}

export interface SftpListing {
  path: string;
  parent: string;
  entries: SftpEntry[];
}

/** Credenciais digitadas agora (host sem credencial salva); so' em memoria. */
export interface SshTyped {
  password?: string;
  passphrase?: string;
}

export interface SerialProfile {
  id: string;
  name: string;
  group?: string;
  port: string;
  baud: number;
  data_bits: number;
  parity: "none" | "odd" | "even" | "mark" | "space";
  stop_bits: "1" | "1.5" | "2";
  flow: "none" | "rtscts" | "xonxoff";
  line_ending: "cr" | "lf" | "crlf";
  local_echo: boolean;
  timestamps: boolean;
  log_file?: string;
  color?: string;
  notes?: string;
}

export interface SerialPortInfo {
  port: string;
  friendly_name?: string;
  manufacturer?: string;
  vid?: string;
  pid?: string;
  serial_number?: string;
}

/** O que a tela precisa do Connection (mesma origem, token, cookie). */
export interface SshApiClient {
  api<T>(path: string, body?: unknown): Promise<T>;
  upload<T>(path: string, body: Blob, contentType: string, opts?: { signal?: AbortSignal; headers?: Record<string, string> }): Promise<T>;
}

/** Erro de SFTP com o motivo (ex. chave do servidor a confirmar). */
export class SshApiError extends Error {
  result?: SshTestResult;
  code?: string;
  constructor(message: string, extra?: { result?: SshTestResult; code?: string }) {
    super(message);
    this.result = extra?.result;
    this.code = extra?.code;
  }
}

/** base64 de UTF-8 (cabecalhos HTTP so' aceitam ASCII). */
export function b64utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function typedBody(t?: SshTyped): Record<string, string> {
  const o: Record<string, string> = {};
  if (t?.password) o.password = t.password;
  if (t?.passphrase) o.passphrase = t.passphrase;
  return o;
}

/** Resposta {ok:false, code:"unknown_host_key"|...} (chave do servidor a
 *  confirmar) vira SshApiError com o resultado, para a tela perguntar. */
function checkKey<T>(r: T): T {
  const x = r as unknown as SshTestResult;
  if (x && x.ok === false && (x.code === "unknown_host_key" || x.code === "host_key_mismatch")) {
    throw new SshApiError(x.error ?? "chave do servidor", { code: x.code, result: x });
  }
  return r;
}

/** Erros do Connection.upload carregam os campos do corpo (ex. code "exists"). */
function wrap(e: unknown): never {
  if (e instanceof SshApiError) throw e;
  const err = e as Error & { code?: string };
  throw new SshApiError(err?.message ?? String(e), { code: err?.code });
}

export const sshApi = {
  list: (c: SshApiClient) => c.api<{ hosts: SshHost[]; recent: SshRecent[]; hosts_file: string; known_hosts_file: string }>("/api/ssh/hosts"),
  save: (
    c: SshApiClient,
    host: Partial<SshHost>,
    cred: { password?: string; save_password?: boolean; clear_password?: boolean; passphrase?: string; save_passphrase?: boolean; clear_passphrase?: boolean },
  ) => c.api<{ host: SshHost }>("/api/ssh/hosts/save", { host, ...cred }),
  remove: (c: SshApiClient, id: string) => c.api<{ ok: boolean }>("/api/ssh/hosts/delete", { id }),
  duplicate: (c: SshApiClient, id: string) => c.api<{ host: SshHost }>("/api/ssh/hosts/duplicate", { id }),
  /** host salvo (id) ou formulario ainda nao salvo (host) */
  test: (c: SshApiClient, target: { id?: string; host?: Partial<SshHost> }, typed?: SshTyped) =>
    c.api<SshTestResult>("/api/ssh/hosts/test", { ...target, ...typedBody(typed) }),
  trust: (c: SshApiClient, target: { id?: string; host?: Partial<SshHost> }, fingerprint: string, typed?: SshTyped) =>
    c.api<SshTestResult>("/api/ssh/hosts/trust", { ...target, fingerprint, ...typedBody(typed) }),
  forgetKey: (c: SshApiClient, id: string) => c.api<{ removed: number }>("/api/ssh/hosts/forget-key", { id }),
  configCandidates: (c: SshApiClient) => c.api<{ path: string; candidates: SshConfigCandidate[] }>("/api/ssh/config-import"),
  configImport: (c: SshApiClient, aliases: string[]) =>
    c.api<{ imported: number; errors?: string[] }>("/api/ssh/config-import", { aliases }),
};

export const sftpApi = {
  list: (c: SshApiClient, id: string, path: string, typed?: SshTyped) =>
    c.api<SftpListing>("/api/ssh/sftp/list", { id, path, ...typedBody(typed) }).then(checkKey, wrap),
  download: (c: SshApiClient, id: string, path: string, typed?: SshTyped) =>
    c.api<{ saved: string }>("/api/ssh/sftp/download", { id, path, ...typedBody(typed) }).then(checkKey, wrap),
  reveal: (c: SshApiClient, path: string) => c.api<{ ok: boolean }>("/api/ssh/sftp/reveal", { path }),
  mkdir: (c: SshApiClient, id: string, path: string, typed?: SshTyped) =>
    c.api<{ ok: boolean }>("/api/ssh/sftp/mkdir", { id, path, ...typedBody(typed) }).then(checkKey, wrap),
  rename: (c: SshApiClient, id: string, from: string, to: string, typed?: SshTyped) =>
    c.api<{ ok: boolean }>("/api/ssh/sftp/rename", { id, from, to, ...typedBody(typed) }).then(checkKey, wrap),
  remove: (c: SshApiClient, id: string, path: string, isDir: boolean, typed?: SshTyped) =>
    c.api<{ ok: boolean }>("/api/ssh/sftp/remove", { id, path, is_dir: isDir, ...typedBody(typed) }).then(checkKey, wrap),
  upload: (c: SshApiClient, id: string, path: string, file: Blob, overwrite: boolean, typed?: SshTyped, signal?: AbortSignal) => {
    const headers: Record<string, string> = {};
    if (typed?.password) headers["X-SSH-Password-B64"] = b64utf8(typed.password);
    if (typed?.passphrase) headers["X-SSH-Passphrase-B64"] = b64utf8(typed.passphrase);
    const q = new URLSearchParams({ id, path });
    if (overwrite) q.set("overwrite", "1");
    return c.upload<{ ok: boolean; bytes: number }>(`/api/ssh/sftp/upload?${q.toString()}`, file, "application/octet-stream", { headers, signal }).then(checkKey, wrap);
  },
  /** Abre bethterm-web.exe --sftp <id> numa janela OS separada (Studio remoto: outra aba). */
  openWindow: (c: SshApiClient, id: string) => {
    if (isRemote()) {
      openRemoteTab(`mode=sftp&host=${encodeURIComponent(id)}`);
      return Promise.resolve({ ok: true });
    }
    return c.api<{ ok: boolean }>("/api/ssh/sftp/window", { id });
  },
  jobs: (c: SshApiClient, id?: string) =>
    c.api<{ jobs: SftpJob[] }>("/api/ssh/sftp/jobs" + (id ? `?id=${encodeURIComponent(id)}` : "")),
  enqueue: (
    c: SshApiClient,
    body: { id: string; direction: "upload" | "download"; local: string; remote: string; overwrite?: boolean },
    typed?: SshTyped,
  ) => c.api<{ job: SftpJob }>("/api/ssh/sftp/jobs/enqueue", { ...body, ...typedBody(typed) }).then(checkKey, wrap),
  cancelJob: (c: SshApiClient, job_id: string) => c.api<{ ok: boolean }>("/api/ssh/sftp/jobs/cancel", { job_id }),
  clearJobs: (c: SshApiClient, id?: string, done_only = true) =>
    c.api<{ ok: boolean }>("/api/ssh/sftp/jobs/clear", { id, done_only }),
};

export interface SftpJob {
  id: string;
  host_id: string;
  direction: "upload" | "download";
  local: string;
  remote: string;
  state: "queued" | "running" | "done" | "error" | "cancelled";
  total: number;
  transferred: number;
  speed_bps: number;
  message?: string;
  started?: number;
  finished?: number;
}

export const localFsApi = {
  list: (c: SshApiClient, path = "") =>
    c.api<{ path: string; parent: string; entries: SftpEntry[]; roots?: string[] }>("/api/local-fs/list", { path }),
  mkdir: (c: SshApiClient, path: string) => c.api<{ ok: boolean }>("/api/local-fs/mkdir", { path }),
  remove: (c: SshApiClient, path: string, is_dir: boolean) =>
    c.api<{ ok: boolean }>("/api/local-fs/remove", { path, is_dir }),
  reveal: (c: SshApiClient, path: string) => c.api<{ ok: boolean }>("/api/local-fs/reveal", { path }),
};

export const serialApi = {
  list: (c: SshApiClient) => c.api<{ profiles: SerialProfile[]; recent: SshRecent[]; profiles_file: string }>("/api/serial/profiles"),
  ports: (c: SshApiClient) => c.api<{ ports: SerialPortInfo[] }>("/api/serial/ports"),
  save: (c: SshApiClient, profile: Partial<SerialProfile>) => c.api<{ profile: SerialProfile }>("/api/serial/profiles/save", { profile }),
  remove: (c: SshApiClient, id: string) => c.api<{ ok: boolean }>("/api/serial/profiles/delete", { id }),
  duplicate: (c: SshApiClient, id: string) => c.api<{ profile: SerialProfile }>("/api/serial/profiles/duplicate", { id }),
};
