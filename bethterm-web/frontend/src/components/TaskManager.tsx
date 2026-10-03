import { Fragment, useEffect, useId, useRef, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CircuitBoard,
  Clock,
  Cpu,
  HardDrive,
  Layers,
  MemoryStick,
  Monitor,
  Server,
  Terminal,
  X,
} from "lucide-react";
import type { Connection } from "@/lib/connection";
import {
  fetchSysmon,
  formatBytes,
  formatPct,
  formatRate,
  formatUptime,
  matchTone,
  nextSort,
  pctOf,
  sortTerminals,
  sparklinePoints,
  swapsByPriority,
  termKey,
  zramRatio,
  type LinuxSwap,
  type ProcStat,
  type SortDir,
  type SysmonSnapshot,
  type TermSortKey,
  type TermStat,
} from "@/lib/sysmon";
import { cn } from "@/lib/utils";
import { KindIcon } from "./KindIcon";

/**
 * "Gerenciador de tarefas": RAM/CPU/GPU/disco, processos do BethTerm, consumo
 * de cada terminal e do WSL. Atualiza a cada 1 s enquanto aberto; fechado,
 * nao consulta nada (e o Go para de amostrar depois de 10 s).
 */
export function TaskManager({ conn, onClose, onGoToPane }: { conn: Connection; onClose: () => void; onGoToPane?: (paneId: number) => void }) {
  const [snap, setSnap] = useState<SysmonSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const s = await fetchSysmon(conn);
        if (!alive) return;
        setSnap(s);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
      if (alive) timer = window.setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [conn]);

  useEffect(() => boxRef.current?.focus(), []);

  return (
    <div className="fixed inset-0 z-[65] flex items-start justify-center bg-black/50 pt-[4vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        ref={boxRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Gerenciador de tarefas"
        className="flex h-[90vh] w-[min(1180px,96vw)] flex-col overflow-hidden rounded-xl border border-border bg-bg-body text-[12px] text-text-1 shadow-2xl outline-none"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className="flex items-center gap-3 border-b border-border bg-bg-card px-5 py-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent-text">
            <Activity size={17} />
          </div>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold leading-tight">Gerenciador de tarefas</div>
            <div className="flex items-center gap-1.5 text-[11px] text-text-3">
              {error ? (
                <span className="truncate text-status-err">erro: {error}</span>
              ) : snap ? (
                <>
                  <span className="h-1.5 w-1.5 animate-led-pulse rounded-full bg-status-ok" />
                  ao vivo · {new Date(snap.at).toLocaleTimeString("pt-BR")}
                  <span title="Tempo gasto para coletar os dados">· coleta {snap.sample_ms.toLocaleString("pt-BR")} ms</span>
                </>
              ) : (
                "carregando…"
              )}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {snap && (
              <>
                <Chip icon={<Clock size={12} />} title="Tempo desde que o Windows foi ligado">
                  ligado há {formatUptime(snap.system.uptime_sec)}
                </Chip>
                <Chip icon={<Layers size={12} />} title="Processos em execução no Windows">
                  {snap.system.processes.toLocaleString("pt-BR")} processos
                </Chip>
              </>
            )}
            <button className="rounded-md p-1.5 text-text-2 hover:bg-bg-hover hover:text-text-1" title="Fechar" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-auto px-5 py-4">
          {!snap ? (
            <div className="py-16 text-center text-text-3">{error ? "Não foi possível ler os dados." : "Coletando…"}</div>
          ) : (
            <>
              <SystemSection s={snap} />
              <BethTermSection s={snap} />
              <TerminalsSection s={snap} onGoToPane={onGoToPane} />
              <WSLSection s={snap} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// --- pecas ---

type Tone = "accent" | "busy" | "ok" | "warn" | "err";

const TONE_TEXT: Record<Tone, string> = {
  accent: "text-accent-text",
  busy: "text-status-busy",
  ok: "text-status-ok",
  warn: "text-status-warn",
  err: "text-status-err",
};
const TONE_BG: Record<Tone, string> = {
  accent: "bg-accent",
  busy: "bg-status-busy",
  ok: "bg-status-ok",
  warn: "bg-status-warn",
  err: "bg-status-err",
};

/** Cor de ocupacao: a da metrica ate' 75 %, depois aviso e erro. */
function loadTone(pct: number, base: Tone): Tone {
  return pct >= 90 ? "err" : pct >= 75 ? "warn" : base;
}

function Chip({ icon, title, children }: { icon?: React.ReactNode; title?: string; children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-border bg-bg-panel px-2 py-0.5 text-[11px] tabular-nums text-text-2"
      title={title}
    >
      {icon && <span className="text-text-3">{icon}</span>}
      {children}
    </span>
  );
}

function Section({ icon, title, extra, children }: { icon: React.ReactNode; title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <header className="mb-2 flex min-h-[22px] items-center gap-2 px-0.5">
        <span className="text-text-3">{icon}</span>
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-2">{title}</span>
        {extra && <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">{extra}</div>}
      </header>
      {children}
    </section>
  );
}

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("min-w-0 rounded-xl border border-border bg-bg-card", className)}>{children}</div>;
}

function Bar({ pct, tone = "accent", title }: { pct: number; tone?: Tone; title?: string }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-hover" title={title}>
      <div className={cn("h-full rounded-full transition-[width] duration-500", TONE_BG[tone])} style={{ width: `${p}%` }} />
    </div>
  );
}

/** Grafico de area dos ultimos 60 s (0..100), alinhado a direita. */
function AreaChart({ values, label, tone, height = 40 }: { values: number[]; label: string; tone: Tone; height?: number }) {
  const w = 240;
  const h = height;
  const pts = sparklinePoints(values, w, h);
  const xs = pts ? pts.split(" ").map((p) => p.split(",")[0]) : [];
  const gid = useId();
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={cn("block w-full", TONE_TEXT[tone])} style={{ height }} aria-label={label}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.35" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.03" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1="0" y1={h * f} x2={w} y2={h * f} className="stroke-border" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      ))}
      {pts && (
        <>
          <polygon points={`${xs[0]},${h} ${pts} ${xs[xs.length - 1]},${h}`} fill={`url(#${gid})`} />
          <polyline points={pts} fill="none" className="stroke-current" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </>
      )}
    </svg>
  );
}

/** Pares "nome  valor" em letra pequena, abaixo do numero principal. */
function Facts({ items, cols = 1 }: { items: [string, React.ReactNode, string?][]; cols?: 1 | 2 }) {
  return (
    <div className={cn("grid gap-x-4 gap-y-0.5 text-[11px]", cols === 2 ? "grid-cols-2" : "grid-cols-1")}>
      {items.map(([k, v, title]) => (
        <div key={k} className="flex min-w-0 justify-between gap-2" title={title}>
          <span className="shrink-0 text-text-3">{k}</span>
          <span className="truncate tabular-nums text-text-2">{v}</span>
        </div>
      ))}
    </div>
  );
}

/** Card de uma metrica: rotulo, % grande, valor absoluto ao lado e o que vier embaixo. */
function MetricCard({
  icon,
  label,
  hint,
  pct,
  value,
  detail,
  tone,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  pct?: number;
  value?: string;
  detail?: React.ReactNode;
  tone: Tone;
  children?: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-2.5 p-3.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-bg-hover", TONE_TEXT[tone])}>{icon}</span>
        <span className="shrink-0 text-[12px] font-medium text-text-2">{label}</span>
        {hint && (
          <span className="ml-auto truncate text-[11px] text-text-3" title={hint}>
            {hint}
          </span>
        )}
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="shrink-0 text-[26px] font-semibold leading-none tracking-tight tabular-nums">{value ?? formatPct(pct)}</span>
        {detail && (
          <span className="truncate text-[11px] tabular-nums text-text-2" title={typeof detail === "string" ? detail : undefined}>
            {detail}
          </span>
        )}
      </div>
      {children}
    </Card>
  );
}

// --- Sistema ---

function SystemSection({ s }: { s: SysmonSnapshot }) {
  const sys = s.system;
  const ramPct = pctOf(sys.ram_used, sys.ram_total);
  const cores = sys.cores ?? [];
  const gpus = s.gpu.adapters ?? [];
  const nv = s.gpu.nvidia ?? [];
  const d = s.disk;
  const diskPct = pctOf(d.total - d.free, d.total);
  return (
    <Section icon={<Cpu size={14} />} title="Sistema">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        <MetricCard icon={<Cpu size={14} />} label="CPU" hint={`${cores.length} núcleos lógicos`} pct={sys.cpu} tone="accent">
          <AreaChart values={s.cpu_history ?? []} label="CPU nos últimos 60 s" tone="accent" />
          {cores.length > 0 && (
            <div className="flex h-4 items-end gap-px" title="Uso por núcleo">
              {cores.map((c, i) => (
                <div key={i} className="flex h-full flex-1 items-end rounded-[1px] bg-bg-hover" title={`Núcleo ${i}: ${formatPct(c)}`}>
                  <div className={cn("w-full rounded-[1px]", TONE_BG[loadTone(c, "accent")])} style={{ height: `${Math.max(4, c)}%` }} />
                </div>
              ))}
            </div>
          )}
        </MetricCard>

        <MetricCard icon={<MemoryStick size={14} />} label="Memória" pct={ramPct} detail={`${formatBytes(sys.ram_used)} de ${formatBytes(sys.ram_total)}`} tone="busy">
          <Bar pct={ramPct} tone={loadTone(ramPct, "accent")} />
          <Facts
            items={[
              ["livre", formatBytes(sys.ram_available)],
              ["commit", `${formatBytes(sys.commit_used)} / ${formatBytes(sys.commit_limit)}`, "Memória comprometida / limite (RAM + arquivo de paginação)"],
            ]}
          />
        </MetricCard>

        {gpus.length === 0 && nv.length === 0 ? (
          <MetricCard icon={<CircuitBoard size={14} />} label="GPU" value="—" detail={s.gpu.note ?? "indisponível"} tone="ok" />
        ) : (
          gpus.map((g) => {
            const n = nv.length === 1 && g.name.includes(nv[0].name) ? nv[0] : undefined;
            return (
              <MetricCard
                key={g.luid}
                icon={<CircuitBoard size={14} />}
                label="GPU"
                hint={g.name}
                pct={g.util}
                detail={n ? `${n.temp_c.toLocaleString("pt-BR")} °C` : undefined}
                tone="ok"
              >
                <Bar pct={g.util} tone={loadTone(g.util, "accent")} title={g.top_engine ? `motor mais ocupado: ${g.top_engine}` : undefined} />
                <Facts
                  items={[
                    [
                      "dedicada",
                      n ? `${formatBytes(g.dedicated_used)} / ${formatBytes(n.mem_total)}` : formatBytes(g.dedicated_used),
                      n ? `VRAM ${formatPct(pctOf(n.mem_used, n.mem_total))}` : undefined,
                    ],
                    ["compartilhada", formatBytes(g.shared_used), "Memória compartilhada (RAM usada pela GPU)"],
                  ]}
                />
              </MetricCard>
            );
          })
        )}
        {nv
          .filter((n) => !gpus.some((g) => g.name.includes(n.name)))
          .map((n) => (
            <MetricCard key={n.name} icon={<CircuitBoard size={14} />} label="GPU" hint={`${n.name} (nvidia-smi)`} pct={n.util} detail={`${n.temp_c} °C`} tone="ok">
              <Bar pct={n.util} tone={loadTone(n.util, "accent")} />
              <Facts items={[["VRAM", `${formatBytes(n.mem_used)} / ${formatBytes(n.mem_total)}`]]} />
            </MetricCard>
          ))}

        <MetricCard icon={<HardDrive size={14} />} label={`Disco ${d.drive}`} pct={diskPct} detail={`${formatBytes(d.total - d.free)} de ${formatBytes(d.total)}`} tone="warn">
          <Bar pct={diskPct} tone={loadTone(diskPct, "accent")} title={`${formatBytes(d.free)} livre`} />
          <Facts
            cols={2}
            items={
              d.activity_available
                ? [
                    ["livre", formatBytes(d.free)],
                    ["ativo", formatPct(d.active_pct)],
                    ["leitura", formatRate(d.read_bps)],
                    ["escrita", formatRate(d.write_bps)],
                  ]
                : [
                    ["livre", formatBytes(d.free)],
                    ["atividade", "indisponível"],
                  ]
            }
          />
        </MetricCard>
      </div>
      <WSLUsageStrip w={s.wsl} pcRam={sys.ram_total} />
    </Section>
  );
}

function WSLUsageStrip({ w, pcRam }: { w: SysmonSnapshot["wsl"]; pcRam: number }) {
  const u = w.usage;
  const hist = u?.history ?? [];
  const active = w.vm_running || hist.some((p) => p.ram > 0 || p.cpu > 0 || p.disk_ok);
  if (!active) {
    return (
      <Card className="mt-3 flex items-center gap-2 px-3.5 py-2.5 text-[11px] text-text-3">
        <Terminal size={13} /> WSL2 desligado: não usa memória, CPU nem disco agora.
      </Card>
    );
  }
  const cpu = u?.cpu ?? w.vm?.cpu ?? 0;
  const diskPct = u?.disk_known ? u.disk_pct : 0;
  return (
    <Card className="mt-3 p-3.5">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-bg-hover text-text-2">
          <Terminal size={14} />
        </span>
        <span className="text-[12px] font-medium text-text-2">WSL2</span>
      </div>
      <div className="grid gap-x-8 gap-y-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <WSLMemory u={u} vmBytes={u?.ram_bytes || w.vm?.ws || 0} pcRam={pcRam} />
        <div className="grid min-w-0 content-start gap-4">
          <div className="min-w-0">
            <div className="mb-1 flex items-baseline gap-2">
              <span className="text-[12px] text-text-2">Processador</span>
              <span className="ml-auto text-[15px] font-semibold leading-none tabular-nums">{formatPct(cpu)}</span>
              <span className="text-[11px] text-text-3">da CPU do PC</span>
            </div>
            <AreaChart values={hist.map((p) => p.cpu)} label="CPU do WSL2 nos últimos 60 s" tone="accent" height={32} />
            <div className="mt-0.5 text-[10.5px] text-text-3">últimos 60 s</div>
          </div>
          <div className="min-w-0">
            <div className="mb-1.5 flex items-baseline gap-2">
              <span className="shrink-0 text-[12px] text-text-2">Disco{u?.disk_distro ? ` do ${u.disk_distro}` : ""}</span>
              <span className="ml-auto truncate text-[12px] tabular-nums text-text-1">
                {u?.disk_known ? (
                  <>
                    <b className="font-semibold">{formatBytes(u.disk_used)}</b> <span className="text-text-3">de {formatBytes(u.disk_total)}</span>
                  </>
                ) : (
                  "lendo a distro…"
                )}
              </span>
            </div>
            <Bar pct={diskPct} tone={loadTone(diskPct, "accent")} />
            {u?.disk_known && (
              <div className="mt-1 text-[10.5px] tabular-nums text-text-3">{formatBytes(Math.max(0, u.disk_total - u.disk_used))} livres no disco virtual</div>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

/**
 * Memoria do WSL2 como uma regua: a trilha inteira e' o limite da VM
 * (MemTotal do Linux); por cima, o que a VM ocupa de fato na RAM do
 * Windows (vmmem, inclui cache) e, mais escuro, o que o Linux usa.
 */
function WSLMemory({ u, vmBytes, pcRam }: { u: SysmonSnapshot["wsl"]["usage"]; vmBytes: number; pcRam: number }) {
  if (!u?.ram_known) {
    return (
      <div className="min-w-0">
        <div className="mb-1 text-[12px] text-text-2">Memória</div>
        <div className="text-[11px] text-text-3">Lendo a memória da distro…</div>
      </div>
    );
  }
  const limit = u.ram_reserved;
  const used = Math.min(u.ram_used, limit);
  const held = Math.min(Math.max(vmBytes, used), limit);
  const w = (n: number) => `${limit > 0 ? (n / limit) * 100 : 0}%`;
  const free = Math.max(0, limit - held);
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-[12px] text-text-2">Memória</span>
        <span className="ml-auto text-[12px] tabular-nums text-text-3">
          limite <b className="font-semibold text-text-1">{formatBytes(limit)}</b>
        </span>
      </div>
      <div
        className="relative h-3.5 w-full overflow-hidden rounded-md bg-bg-hover ring-1 ring-inset ring-border"
        role="img"
        aria-label={`Linux usa ${formatBytes(u.ram_used)}, a VM ocupa ${formatBytes(vmBytes)} no Windows, limite ${formatBytes(limit)}`}
      >
        {held > used && (
          <div
            className="absolute inset-y-0 left-0 bg-status-busy/35 transition-[width] duration-500"
            style={{
              width: w(held),
              backgroundImage: "repeating-linear-gradient(135deg, rgb(var(--bt-busy) / 0.45) 0 2px, transparent 2px 6px)",
            }}
          />
        )}
        <div className="absolute inset-y-0 left-0 bg-status-busy transition-[width] duration-500" style={{ width: w(used) }} />
      </div>
      <div className="mt-2.5 grid grid-cols-3 gap-3">
        <MemLegend swatch="bg-status-busy" label="Em uso no Linux" value={formatBytes(u.ram_used)} note={`${formatPct(u.ram_pct)} do limite`} />
        <MemLegend
          swatch="bg-status-busy/35"
          hatch
          label="Ocupa no Windows"
          value={vmBytes ? formatBytes(vmBytes) : "—"}
          note={vmBytes && pcRam ? `uso + cache · ${formatPct(pctOf(vmBytes, pcRam))} da RAM do PC` : "uso + cache do Linux"}
          title="Working set do processo vmmem: o que o WSL2 tirou de fato da RAM do Windows, incluindo cache de disco do Linux"
        />
        <MemLegend swatch="bg-bg-hover ring-1 ring-inset ring-border" label="Ainda pode crescer" value={formatBytes(free)} note="até o limite" />
      </div>
      <p className="mt-2.5 text-[11px] leading-snug text-text-3">
        O limite não fica separado para o WSL2: o Windows só entrega memória quando o Linux pede, e a recolhe aos poucos quando ele libera.
      </p>
      <SwapReserve swaps={u.swaps} />
    </div>
  );
}

/**
 * Reserva para picos: as areas de swap na ordem em que o Linux as usa
 * (zram primeiro, disco so' quando o zram lota).
 */
function SwapReserve({ swaps }: { swaps?: LinuxSwap[] | null }) {
  const list = swapsByPriority(swaps);
  if (list.length === 0) {
    return (
      <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-2 text-[11px] text-text-3">
        Sem swap: num pico de memória o Linux encerra processos para liberar RAM.
      </div>
    );
  }
  const size = list.reduce((a, s) => a + s.size, 0);
  const used = list.reduce((a, s) => a + s.used, 0);
  return (
    <div className="mt-3.5 border-t border-border pt-3">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-[12px] text-text-2">Reserva para picos</span>
        <span className="text-[11px] text-text-3">swap, usado nesta ordem</span>
        <span className="ml-auto text-[12px] tabular-nums text-text-3">
          <b className="font-semibold text-text-1">{formatBytes(size - used)}</b> livres de {formatBytes(size)}
        </span>
      </div>
      <div className="grid gap-2">
        {list.map((s, i) => (
          <SwapRow key={s.name} s={s} order={i + 1} />
        ))}
      </div>
    </div>
  );
}

function SwapRow({ s, order }: { s: LinuxSwap; order: number }) {
  const pct = pctOf(s.used, s.size);
  const zram = s.kind === "zram";
  const ratio = zram ? zramRatio(s) : "";
  const title = zram ? "RAM comprimida (zram)" : s.kind === "file" ? "Arquivo em disco" : "Partição em disco";
  const note = zram
    ? s.zram_phys != null
      ? `ocupa ${formatBytes(s.zram_phys)} de RAM${ratio ? ` (${ratio})` : ""}`
      : "rápido: fica na própria RAM"
    : s.used > 0
      ? "em uso: o zram lotou e o sistema fica mais lento"
      : "só entra se o zram lotar";
  return (
    <div className="grid grid-cols-[1.25rem_minmax(0,11rem)_minmax(0,1fr)_auto] items-center gap-x-2.5" title={`${s.name} · prioridade ${s.prio}${ratio ? ` · compressão ${ratio}` : ""}`}>
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-bg-hover text-[10.5px] font-semibold tabular-nums text-text-2">{order}</span>
      <div className="min-w-0">
        <div className="truncate text-[11.5px] text-text-1">{title}</div>
        <div className={cn("truncate text-[10.5px]", !zram && s.used > 0 ? "text-status-warn" : "text-text-3")}>{note}</div>
      </div>
      <Bar pct={pct} tone={loadTone(pct, zram ? "busy" : "accent")} />
      <span className="w-[8.5rem] text-right text-[11.5px] tabular-nums text-text-2">
        <b className="font-semibold text-text-1">{formatBytes(s.used)}</b> de {formatBytes(s.size)}
      </span>
    </div>
  );
}

function MemLegend({ swatch, hatch, label, value, note, title }: { swatch: string; hatch?: boolean; label: string; value: string; note: string; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="flex items-center gap-1.5 text-[11px] text-text-2">
        <span
          className={cn("h-2.5 w-2.5 shrink-0 rounded-[3px]", swatch)}
          style={hatch ? { backgroundImage: "repeating-linear-gradient(135deg, rgb(var(--bt-busy) / 0.6) 0 1.5px, transparent 1.5px 4px)" } : undefined}
        />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-0.5 text-[17px] font-semibold leading-tight tabular-nums">{value}</div>
      <div className="truncate text-[10.5px] tabular-nums text-text-3">{note}</div>
    </div>
  );
}

/** Valor com uma barrinha proporcional ao maior da tabela: mostra de relance quem pesa mais. */
function InlineBar({ value, max, children }: { value: number; max: number; children: React.ReactNode }) {
  const p = max > 0 ? Math.max(3, (value / max) * 100) : 0;
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1 w-12 overflow-hidden rounded-full bg-bg-hover">
        <div className="h-full rounded-full bg-status-busy/80" style={{ width: `${p}%` }} />
      </div>
      <span className="w-[4.5rem] text-right tabular-nums">{children}</span>
    </div>
  );
}

const TH = "px-3 py-2 text-[10.5px] font-medium uppercase tracking-wider text-text-3";
const TD = "px-3 py-1.5";

// --- BethTerm ---

function BethTermSection({ s }: { s: SysmonSnapshot }) {
  const rows = s.bethterm ?? [];
  const total = rows.reduce((a, r) => a + r.private_ws, 0);
  const max = rows.reduce((a, r) => Math.max(a, r.private_ws), 0);
  return (
    <Section
      icon={<Server size={14} />}
      title="BethTerm"
      extra={<Chip title="Soma da RAM dos processos do BethTerm, sem os programas que rodam dentro dos terminais">total {formatBytes(total)}</Chip>}
    >
      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <div className="p-3.5 text-text-3">Nenhum processo do BethTerm encontrado.</div>
        ) : (
          <table className="w-full table-fixed">
            <thead className="bg-bg-panel text-left">
              <tr>
                <th className={TH}>Componente</th>
                <th className={cn(TH, "w-20")}>PID</th>
                <th className={cn(TH, "w-40 text-right")} title="Working set privado (como o Gerenciador de Tarefas do Windows)">
                  RAM
                </th>
                <th className={cn(TH, "w-28 text-right")}>Working set</th>
                <th className={cn(TH, "w-16 text-right")}>CPU</th>
                <th className={cn(TH, "w-16 text-right")}>GPU</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.role}-${r.pid}-${i}`} className="border-t border-border hover:bg-bg-hover">
                  <td className={cn(TD, "truncate")}>{r.label}</td>
                  <td className={cn(TD, "tabular-nums text-text-3")}>{r.pid}</td>
                  <td className={TD}>
                    <InlineBar value={r.private_ws} max={max}>
                      {formatBytes(r.private_ws)}
                    </InlineBar>
                  </td>
                  <td className={cn(TD, "text-right tabular-nums text-text-3")}>{formatBytes(r.ws)}</td>
                  <td className={cn(TD, "text-right tabular-nums")}>{formatPct(r.cpu)}</td>
                  <td className={cn(TD, "text-right tabular-nums text-text-3")}>{r.gpu ? formatPct(r.gpu) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </Section>
  );
}

// --- Terminais ---

const COLS: { key: TermSortKey; label: string; cls: string; title?: string }[] = [
  { key: "title", label: "Título", cls: "text-left" },
  { key: "kind", label: "Tipo", cls: "w-40 text-left" },
  { key: "ram", label: "RAM", cls: "w-40 text-right", title: "Soma do working set privado do shell e de tudo que ele abriu" },
  { key: "cpu", label: "CPU", cls: "w-16 text-right" },
  { key: "procs", label: "Proc.", cls: "w-16 text-right", title: "Processos" },
];

function TerminalsSection({ s, onGoToPane }: { s: SysmonSnapshot; onGoToPane?: (id: number) => void }) {
  const [sort, setSort] = useState<{ key: TermSortKey; dir: SortDir }>({ key: "ram", dir: "desc" });
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const all = s.terminals ?? [];
  const list = sortTerminals(all, sort.key, sort.dir);
  const max = all.reduce((a, t) => Math.max(a, t.procs ? t.private_ws : 0), 0);
  const total = all.reduce((a, t) => a + (t.procs ? t.private_ws : 0), 0);
  const m = s.match;
  const toggle = (k: string) =>
    setOpen((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const matchInfo = `Associação com os processos: ${m.exact} por título exato, ${m.approx} aproximado${m.order ? `, ${m.order} por ordem` : ""}${m.unmatched ? `, ${m.unmatched} não associado(s)` : ""}`;
  return (
    <Section
      icon={<Monitor size={14} />}
      title="Terminais"
      extra={
        <>
          <Chip>{m.panes} terminais</Chip>
          <Chip title="Soma da RAM dos terminais e de tudo que rodam">total {formatBytes(total)}</Chip>
          {m.unmatched > 0 ? (
            <span title={matchInfo}>
              <Chip>
                <span className="h-1.5 w-1.5 rounded-full bg-status-warn" /> {m.unmatched} sem associação
              </Chip>
            </span>
          ) : (
            <span title={matchInfo}>
              <Chip>
                <span className="h-1.5 w-1.5 rounded-full bg-status-ok" /> todos associados
              </Chip>
            </span>
          )}
        </>
      }
    >
      {m.note && <div className="mb-2 text-[11px] text-status-warn">{m.note}</div>}
      <Card className="overflow-hidden">
        <table className="w-full table-fixed">
          <thead className="bg-bg-panel">
            <tr>
              <th className="w-8" />
              {COLS.map((c) => (
                <th key={c.key} className={cn(TH, "px-2", c.cls)} title={c.title}>
                  <button
                    className={cn(
                      "inline-flex items-center gap-0.5 rounded px-1 uppercase hover:bg-bg-hover hover:text-text-1",
                      sort.key === c.key && "text-text-1",
                    )}
                    onClick={() => setSort((cur) => nextSort(cur, c.key))}
                  >
                    {c.label}
                    {sort.key === c.key && (sort.dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map((t) => {
              const k = termKey(t);
              const isOpen = open.has(k);
              return (
                <Fragment key={k}>
                  <TermRow t={t} max={max} isOpen={isOpen} onToggle={() => toggle(k)} onGoToPane={onGoToPane} />
                  {isOpen && (
                    <tr className="bg-bg-panel">
                      <td />
                      <td colSpan={5} className="px-3 pb-2.5 pt-1">
                        <TermDetails t={t} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {list.length === 0 && (
              <tr>
                <td colSpan={6} className="py-4 text-center text-text-3">
                  Nenhum terminal.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </Section>
  );
}

function TermRow({ t, max, isOpen, onToggle, onGoToPane }: { t: TermStat; max: number; isOpen: boolean; onToggle: () => void; onGoToPane?: (id: number) => void }) {
  const tone = matchTone(t.match);
  const canGo = t.pane_id != null && !!onGoToPane;
  return (
    <tr className={cn("cursor-pointer border-t border-border hover:bg-bg-hover", isOpen && "bg-bg-panel")} onClick={onToggle}>
      <td className="py-1.5 pl-3 text-text-3">{t.procs > 0 ? isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}</td>
      <td className="min-w-0 px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone === "ok" ? "bg-status-ok" : tone === "warn" ? "bg-status-warn" : "bg-text-3")}
            title={`Associação: ${t.match_label}`}
          />
          {canGo ? (
            <button
              className="truncate text-left hover:text-accent-text hover:underline"
              title={`Ir para o terminal ${t.pane_id}`}
              onClick={(e) => {
                e.stopPropagation();
                onGoToPane!(t.pane_id!);
              }}
            >
              {t.title || `Terminal ${t.pane_id}`}
            </button>
          ) : (
            <span className="truncate text-text-2">{t.title}</span>
          )}
        </div>
        {t.note && <div className="truncate pl-3.5 text-[10.5px] text-text-3">{t.note}</div>}
      </td>
      <td className="px-2 py-1.5">
        <span className="flex min-w-0 items-center gap-1.5 text-text-2">
          <KindIcon pane={{ kind: t.kind, kind_label: t.kind_label || t.kind }} />
          <span className="truncate">{t.kind_label || t.kind}</span>
        </span>
      </td>
      <td className="px-2 py-1.5" title={`working set ${formatBytes(t.ws)} · privados ${formatBytes(t.private)}`}>
        {t.procs ? (
          <InlineBar value={t.private_ws} max={max}>
            {formatBytes(t.private_ws)}
          </InlineBar>
        ) : (
          <div className="text-right text-text-3">—</div>
        )}
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums">{t.procs ? formatPct(t.cpu) : <span className="text-text-3">—</span>}</td>
      <td className="px-3 py-1.5 text-right tabular-nums text-text-2">{t.procs || <span className="text-text-3">—</span>}</td>
    </tr>
  );
}

function TermDetails({ t }: { t: TermStat }) {
  const top: ProcStat[] = t.top ?? [];
  return (
    <div className="rounded-lg border border-border bg-bg-card p-2.5">
      <div className="mb-1.5 flex flex-wrap gap-1.5">
        <Chip>associação: {t.match_label}</Chip>
        {t.shell_pid ? (
          <Chip>
            shell: {t.shell_name} · PID {t.shell_pid}
          </Chip>
        ) : null}
        {t.console_title && (
          <span className="min-w-0 max-w-full truncate" title={t.console_title}>
            <Chip>título do console: “{t.console_title}”</Chip>
          </span>
        )}
      </div>
      {top.length === 0 ? (
        <div className="text-text-3">Sem processos no Windows para este terminal.</div>
      ) : (
        <table className="w-full table-fixed text-[11.5px]">
          <thead className="text-left text-[10px] uppercase tracking-wider text-text-3">
            <tr>
              <th className="py-1 font-medium">Processo (5 maiores)</th>
              <th className="w-20 font-medium">PID</th>
              <th className="w-24 text-right font-medium">RAM</th>
              <th className="w-16 text-right font-medium">CPU</th>
            </tr>
          </thead>
          <tbody>
            {top.map((p) => (
              <tr key={p.pid} className="border-t border-border/60">
                <td className="truncate py-1 font-mono">{p.name}</td>
                <td className="tabular-nums text-text-3">{p.pid}</td>
                <td className="text-right tabular-nums">{formatBytes(p.private_ws)}</td>
                <td className="text-right tabular-nums">{formatPct(p.cpu)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// --- WSL ---

function WSLSection({ s }: { s: SysmonSnapshot }) {
  const w = s.wsl;
  const distros = w.distros ?? [];
  return (
    <Section
      icon={<HardDrive size={14} />}
      title="WSL"
      extra={
        w.vm ? (
          <>
            <Chip title={`Processo da VM: ${w.vm.name}`}>VM {formatBytes(w.vm.ws)}</Chip>
            <Chip>CPU {formatPct(w.vm.cpu)}</Chip>
          </>
        ) : undefined
      }
    >
      {w.note && <div className="mb-2 text-text-3">{w.note}</div>}
      {w.vm_running && distros.length === 0 && !w.note && <div className="text-text-3">Consultando as distribuições…</div>}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] gap-3">
        {distros.map((d) => (
          <Card key={d.name} className="p-3.5">
            <div className="flex items-center gap-2">
              <span className={cn("h-2 w-2 shrink-0 rounded-full", d.running ? "bg-status-ok" : "bg-text-3")} />
              <span className="font-semibold">{d.name}</span>
              {d.default && <span className="rounded-full bg-accent/15 px-1.5 text-[10px] text-accent-text">padrão</span>}
              <span className="text-[11px] text-text-3">
                {d.state} · WSL{d.version}
              </span>
              {d.load && (
                <span className="ml-auto text-[11px] tabular-nums text-text-3" title="load average 1/5/15 min">
                  carga {d.load.map((x) => x.toLocaleString("pt-BR")).join(" · ")}
                </span>
              )}
            </div>
            {!d.running ? (
              <div className="mt-1.5 text-[11px] text-text-3">Parada — não é consultada (nunca é iniciada por aqui).</div>
            ) : (
              <>
                {d.mem && (
                  <UsageRow
                    label="Memória"
                    pct={pctOf(d.mem.used, d.mem.total)}
                    left={`${formatBytes(d.mem.used)} de ${formatBytes(d.mem.total)}`}
                    right={`${formatBytes(d.mem.available)} disponível${d.mem.swap_total ? ` · swap ${formatBytes(d.mem.swap_used)}` : ""}`}
                  />
                )}
                {d.disk && (
                  <UsageRow
                    label="Disco"
                    pct={pctOf(d.disk.used, d.disk.total)}
                    left={`${formatBytes(d.disk.used)} de ${formatBytes(d.disk.total)}`}
                    right={`${formatBytes(d.disk.avail)} livre`}
                  />
                )}
                {d.error && <div className="mt-1.5 text-[11px] text-status-warn">{d.error}</div>}
                {d.top && d.top.length > 0 && (
                  <table className="mt-3 w-full table-fixed text-[11.5px]">
                    <thead className="text-left text-[10px] uppercase tracking-wider text-text-3">
                      <tr>
                        <th className="py-1 font-medium">Processo</th>
                        <th className="w-20 font-medium">PID</th>
                        <th className="w-20 text-right font-medium">RSS</th>
                        <th className="w-14 text-right font-medium" title="Média desde o início do processo (ps)">
                          CPU*
                        </th>
                        <th className="w-24 text-right font-medium">Tempo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.top.slice(0, 10).map((p) => (
                        <tr key={p.pid} className="border-t border-border/60">
                          <td className="truncate py-1 font-mono">{p.comm}</td>
                          <td className="tabular-nums text-text-3">{p.pid}</td>
                          <td className="text-right tabular-nums">{formatBytes(p.rss)}</td>
                          <td className="text-right tabular-nums">{formatPct(p.pcpu)}</td>
                          <td className="text-right tabular-nums text-text-3">{p.elapsed}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </Card>
        ))}
      </div>
      {distros.some((d) => d.running) && (
        <div className="mt-2 px-0.5 text-[10.5px] text-text-3">
          As distros WSL2 dividem a mesma VM: a memória de cada uma é a da VM. CPU* do ps é a média desde o início do processo. Terminais WSL
          aparecem na tabela acima só com o lado Windows (wsl.exe).
        </div>
      )}
    </Section>
  );
}

function UsageRow({ label, pct, left, right }: { label: string; pct: number; left: string; right: string }) {
  return (
    <div className="mt-2.5">
      <div className="mb-1 flex items-baseline gap-2 text-[11px]">
        <span className="text-text-3">{label}</span>
        <span className="font-semibold tabular-nums text-text-1">{formatPct(pct)}</span>
        <span className="tabular-nums text-text-2">{left}</span>
        <span className="ml-auto truncate tabular-nums text-text-3">{right}</span>
      </div>
      <Bar pct={pct} tone={loadTone(pct, "accent")} />
    </div>
  );
}
