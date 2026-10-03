// Gerenciador de tarefas: tipos do GET /api/sysmon (sysmon.go), formatacao
// e ordenacao. Funcoes puras testadas em tests/sysmon.test.ts.

import type { Connection } from "./connection";

export interface ProcStat {
  name: string;
  pid: number;
  ws: number;
  /** "Memoria" do Gerenciador de Tarefas do Windows (working set privado) */
  private_ws: number;
  private: number;
  /** % da maquina inteira */
  cpu: number;
  gpu?: number;
  count?: number;
}

export interface BethProc extends ProcStat {
  role: "host" | "consoles" | "gui" | "web" | "bridge" | "webview" | "cli" | "other-host";
  label: string;
}

export type MatchKind = "exato" | "aproximado" | "ordem" | "nao_associado" | "sem_processo";

export interface TermStat {
  pane_id: number | null;
  title: string;
  kind: string;
  kind_label: string;
  match: MatchKind;
  match_label: string;
  console_title?: string;
  shell_pid?: number;
  shell_name?: string;
  ws: number;
  private_ws: number;
  private: number;
  cpu: number;
  procs: number;
  top: ProcStat[] | null;
  note?: string;
}

export interface GPUAdapter {
  luid: string;
  name: string;
  util: number;
  top_engine: string;
  dedicated_used: number;
  shared_used: number;
}

export interface NvidiaGPU {
  name: string;
  temp_c: number;
  mem_total: number;
  mem_used: number;
  util: number;
}

export interface LinuxMem {
  total: number;
  used: number;
  free: number;
  available: number;
  buff_cache: number;
  swap_total: number;
  swap_used: number;
  swaps?: LinuxSwap[];
}

/** Uma area de /proc/swaps. zram = RAM comprimida; zram_phys e' a RAM que ela ocupa de fato. */
export interface LinuxSwap {
  name: string;
  kind: "zram" | "file" | "partition";
  size: number;
  used: number;
  prio: number;
  zram_phys?: number;
  zram_limit?: number;
}

/** Swaps na ordem em que o Linux usa (maior prioridade primeiro). */
export function swapsByPriority(swaps: readonly LinuxSwap[] | null | undefined): LinuxSwap[] {
  return [...(swaps ?? [])].sort((a, b) => b.prio - a.prio);
}

/** Taxa de compressao do zram ("4,4:1"), ou "" sem dado suficiente. */
export function zramRatio(s: Pick<LinuxSwap, "used" | "zram_phys">): string {
  if (!s.zram_phys || s.used < 16 * 1024 * 1024) return "";
  return `${(s.used / s.zram_phys).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}:1`;
}

export interface LinuxDisk {
  total: number;
  used: number;
  avail: number;
  mount: string;
}

/** Um segundo do grafico do WSL2 (0..100). disk_ok e' falso ate' o df chegar. */
export interface WSLPoint {
  ram: number;
  ram_ok: boolean;
  cpu: number;
  disk: number;
  disk_ok: boolean;
}

export interface WSLUsage {
  ram_bytes: number;
  /** usado dentro do WSL2 (coluna used do free) */
  ram_used: number;
  /** total que a VM enxerga (reservado para o WSL2) */
  ram_reserved: number;
  /** usado / reservado */
  ram_pct: number;
  ram_known: boolean;
  cpu: number;
  disk_used: number;
  disk_total: number;
  disk_pct: number;
  disk_distro?: string;
  disk_known: boolean;
  swaps?: LinuxSwap[] | null;
  history: WSLPoint[] | null;
}

export interface LinuxProc {
  pid: number;
  rss: number;
  pcpu: number;
  elapsed: string;
  comm: string;
}

export interface WSLDistro {
  name: string;
  state: string;
  version: number;
  default: boolean;
  running: boolean;
  mem?: LinuxMem;
  disk?: LinuxDisk;
  load?: number[];
  top?: LinuxProc[];
  error?: string;
  sampled_at?: string;
}

export interface SysmonSnapshot {
  at: string;
  sample_ms: number;
  system: {
    ram_total: number;
    ram_available: number;
    ram_used: number;
    ram_load: number;
    commit_used: number;
    commit_limit: number;
    cpu: number;
    cores: number[] | null;
    uptime_sec: number;
    processes: number;
  };
  cpu_history: number[] | null;
  gpu: { available: boolean; note?: string; adapters: GPUAdapter[] | null; nvidia?: NvidiaGPU[] | null };
  disk: { drive: string; total: number; free: number; read_bps: number; write_bps: number; active_pct: number; activity_available: boolean };
  bethterm: BethProc[] | null;
  terminals: TermStat[] | null;
  match: {
    panes: number;
    shells: number;
    exact: number;
    approx: number;
    order: number;
    unmatched: number;
    titles_available: boolean;
    host_pid: number;
    note?: string;
  };
  wsl: { vm: ProcStat | null; vm_running: boolean; distros: WSLDistro[] | null; note?: string; usage?: WSLUsage };
}

export function fetchSysmon(conn: Pick<Connection, "api">): Promise<SysmonSnapshot> {
  return conn.api<SysmonSnapshot>("/api/sysmon");
}

// --- formatacao (pt-BR) ---

const nf = (digits: number) => new Intl.NumberFormat("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** 1536 -> "1,5 KB"; 734003200 -> "700 MB"; 17179869184 -> "16,0 GB". Base 1024. */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : i >= 3 ? 1 : v < 10 ? 1 : 0;
  return `${nf(digits).format(v)} ${units[i]}`;
}

export function formatRate(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps)) return "—";
  return `${formatBytes(bps)}/s`;
}

/** 12.345 -> "12,3%"; 0 -> "0%". */
export function formatPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v === 0) return "0%";
  if (v > 0 && v < 0.1) return "<0,1%";
  return `${nf(digits).format(v)}%`;
}

/** 90061 -> "1d 1h 1min". */
export function formatUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}min`;
  if (h > 0) return `${h}h ${m}min`;
  return `${m}min`;
}

export function pctOf(part: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, (part / total) * 100));
}

// --- ordenacao da tabela de terminais ---

export type TermSortKey = "title" | "kind" | "ram" | "cpu" | "procs";
export type SortDir = "asc" | "desc";

/** Primeiro clique: numeros do maior para o menor, texto de A a Z. */
export function defaultDir(key: TermSortKey): SortDir {
  return key === "title" || key === "kind" ? "asc" : "desc";
}

export function nextSort(cur: { key: TermSortKey; dir: SortDir }, key: TermSortKey): { key: TermSortKey; dir: SortDir } {
  if (cur.key === key) return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
  return { key, dir: defaultDir(key) };
}

const collator = new Intl.Collator("pt-BR", { sensitivity: "base", numeric: true });

/** Ordena sem mutar; empate desempata por RAM e depois pelo id do pane. */
export function sortTerminals(list: readonly TermStat[], key: TermSortKey, dir: SortDir): TermStat[] {
  const sign = dir === "asc" ? 1 : -1;
  const val = (t: TermStat): number | string => {
    switch (key) {
      case "title":
        return t.title;
      case "kind":
        return t.kind_label || t.kind || "";
      case "ram":
        return t.private_ws;
      case "cpu":
        return t.cpu;
      case "procs":
        return t.procs;
    }
  };
  return [...list].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    let c = typeof va === "string" && typeof vb === "string" ? collator.compare(va, vb) : (va as number) - (vb as number);
    if (c !== 0) return c * sign;
    c = b.private_ws - a.private_ws;
    if (c !== 0) return c;
    return (a.pane_id ?? 1e9) - (b.pane_id ?? 1e9);
  });
}

/** Linha estavel para React (pane ou shell sem pane). */
export function termKey(t: TermStat): string {
  return t.pane_id != null ? `p${t.pane_id}` : `s${t.shell_pid ?? t.title}`;
}

export function matchTone(m: MatchKind): "ok" | "warn" | "muted" {
  return m === "exato" ? "ok" : m === "aproximado" || m === "ordem" ? "warn" : "muted";
}

/**
 * Valores de uma serie do grafico, alinhados ao fim da janela.
 * Pontos iniciais sem dado (ok falso) ficam de fora; um buraco no meio
 * repete o ultimo valor conhecido para a linha nao encolher.
 */
export function historySeries(points: readonly { ok: boolean; v: number }[], slots = 60): number[] {
  const tail = points.slice(-slots);
  const out: number[] = [];
  let last = 0;
  let started = false;
  for (const p of tail) {
    if (!p.ok) {
      if (started) out.push(last);
      continue;
    }
    started = true;
    last = p.v;
    out.push(p.v);
  }
  return out;
}

/** Pontos "x,y" de uma sparkline (0..100 no eixo y, ultimos `slots` valores). */
export function sparklinePoints(values: readonly number[], width: number, height: number, slots = 60): string {
  const vs = values.slice(-slots);
  if (vs.length === 0) return "";
  const step = slots > 1 ? width / (slots - 1) : width;
  const x0 = width - (vs.length - 1) * step;
  return vs
    .map((v, i) => {
      const y = height - (Math.max(0, Math.min(100, v)) / 100) * height;
      return `${(x0 + i * step).toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}
