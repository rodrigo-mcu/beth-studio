import { useCallback, useEffect, useState } from "react";
import type { Connection } from "@/lib/connection";

// Configurações > Arquivos temporários (tempclean.go): apaga sozinho o que o
// Studio cria em C:\tmp\bethstudio (imagens/arquivos colados e textos longos
// do Falar) quando passa de N dias.

interface View {
  enabled: boolean;
  days: number;
  files: number;
  bytes: number;
  old_files: number;
  old_bytes: number;
  removed_files?: number;
  removed_bytes?: number;
  dirs: string[];
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

const btn = "rounded-md border border-border bg-bg-panel px-3 py-1.5 text-[12px] text-text-1 hover:bg-bg-hover disabled:opacity-50";

export function TempCleanSection({ conn, onMessage }: { conn: Connection; onMessage: (m: string) => void }) {
  const [v, setV] = useState<View | null>(null);
  const [days, setDays] = useState("10");
  const [busy, setBusy] = useState(false);

  const apply = useCallback((n: View) => {
    setV(n);
    setDays(String(n.days));
  }, []);
  useEffect(() => {
    conn.api<View>("/api/temp-clean").then(apply).catch((e: Error) => onMessage(e.message));
  }, [conn, apply, onMessage]);

  const save = async (enabled: boolean, d: number) => {
    setBusy(true);
    try {
      apply(await conn.api<View>("/api/temp-clean", { enabled, days: d }));
    } catch (e) {
      onMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const runNow = async () => {
    setBusy(true);
    try {
      const n = await conn.api<View>("/api/temp-clean/run", {});
      apply(n);
      onMessage(n.removed_files ? `Apagados ${n.removed_files} arquivos (${formatBytes(n.removed_bytes ?? 0)})` : "Nada para apagar");
    } catch (e) {
      onMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!v) return <div className="px-5 py-4 text-[13px] text-text-2">Carregando…</div>;
  const d = Math.max(1, Math.min(365, Math.round(Number(days)) || v.days));
  return (
    <div className="space-y-4 px-5 py-4 text-[13px] text-text-1">
      <p className="text-text-2">
        O Studio guarda aqui as imagens e arquivos que você cola nos terminais e os textos longos do Falar (a instrução que vai para o agente aponta para
        eles). Esta limpeza apaga sozinha o que for mais velho que o prazo abaixo. Só mexe nos arquivos que o próprio Studio criou.
      </p>
      <label className="flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={v.enabled} disabled={busy} onChange={(e) => void save(e.target.checked, d)} />
        <span className="font-semibold">Apagar arquivos temporários antigos automaticamente</span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <span>Apagar o que tiver mais de</span>
        <input
          type="number"
          min={1}
          max={365}
          className="w-20 rounded-md border border-border bg-bg-term px-2 py-1 text-right text-text-1"
          value={days}
          onChange={(e) => setDays(e.target.value)}
          onBlur={() => d !== v.days && void save(v.enabled, d)}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        <span>dias</span>
        {[10, 15, 30].map((n) => (
          <button key={n} className={btn} disabled={busy || n === v.days} onClick={() => void save(v.enabled, n)}>
            {n} dias
          </button>
        ))}
      </div>
      <div className="rounded-md border border-border bg-bg-panel p-3 text-[12px] text-text-2">
        <div>
          Agora: <b className="text-text-1">{v.files}</b> arquivos ({formatBytes(v.bytes)}). Passaram do prazo: <b className="text-text-1">{v.old_files}</b> (
          {formatBytes(v.old_bytes)}).
        </div>
        <div className="mt-1 break-all font-mono text-[11px]">{v.dirs.join("  ·  ")}</div>
      </div>
      <button className={btn} disabled={busy || v.old_files === 0} onClick={() => void runNow()}>
        Apagar os antigos agora
      </button>
      <p className="text-[12px] text-text-3">A limpeza roda 1 minuto depois de abrir o Studio e a cada 6 horas, só enquanto estiver ligada.</p>
    </div>
  );
}
