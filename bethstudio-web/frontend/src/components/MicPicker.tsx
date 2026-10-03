import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Loader2, Mic } from "lucide-react";
import type { Connection } from "@/lib/connection";
import { audioConstraints, audioInputs, micLabel, micLog, resolveMic, rmsLevel, testVerdict, type MicChoice, type MicDevice } from "@/lib/mic";
import { micErrorMessage } from "@/lib/voice";
import { cn } from "@/lib/utils";

/** Lista de microfones (os nomes so' aparecem depois de alguma permissao). */
export function useMicDevices() {
  const [devices, setDevices] = useState<MicDevice[]>([]);
  const refresh = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.map((d) => ({ deviceId: d.deviceId, label: d.label, kind: d.kind })));
    } catch {
      setDevices([]);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const md = navigator.mediaDevices;
    md?.addEventListener?.("devicechange", refresh);
    return () => md?.removeEventListener?.("devicechange", refresh);
  }, [refresh]);
  return { devices, refresh };
}

interface Props {
  conn: Connection;
  value: MicChoice;
  onChange: (c: MicChoice) => void;
  /** mostra o "Testar microfone" */
  withTest?: boolean;
  disabled?: boolean;
}

/** Seletor de microfone ("Padrão do Windows" + cada dispositivo) e teste com medidor. */
export function MicPicker({ conn, value, onChange, withTest, disabled }: Props) {
  const { devices, refresh } = useMicDevices();
  const ins = audioInputs(devices);
  const noNames = ins.length > 0 && ins.every((d) => !d.label);
  const resolved = resolveMic(devices, value);
  const selected = value.id ? (resolved.found ? resolved.deviceId : value.id) : "";

  const askNames = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch (e) {
      micLog(conn, `nomes: getUserMedia erro ${(e as DOMException).name}`);
    }
    await refresh();
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Mic size={14} className="shrink-0 text-text-2" />
        <select
          className="h-8 min-w-0 max-w-full flex-1 rounded border border-border bg-bg-term px-2 text-text-1"
          value={selected}
          disabled={disabled}
          onChange={(e) => {
            const id = e.target.value;
            const d = ins.find((x) => x.deviceId === id);
            onChange({ id, label: d?.label ?? "" });
          }}
        >
          <option value="">Padrão do Windows</option>
          {ins.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {micLabel(d, i)}
            </option>
          ))}
          {value.id && !resolved.found && <option value={value.id}>{value.label || "Microfone salvo"} (não encontrado)</option>}
        </select>
        {noNames && (
          <button className="rounded bg-bg-hover px-2 py-1 text-[12px] text-text-1 hover:bg-border" onClick={() => void askNames()}>
            Mostrar nomes
          </button>
        )}
      </div>
      {value.id && !resolved.found && (
        <div className="text-[11px] text-status-warn">O microfone salvo ({value.label || value.id}) não está conectado: será usado o padrão do Windows.</div>
      )}
      {withTest && <MicTest conn={conn} deviceId={value.id ? resolved.deviceId : ""} onDone={refresh} />}
    </div>
  );
}

/** "Testar microfone": 5 s de medidor ao vivo e o veredito. */
function MicTest({ conn, deviceId, onDone }: { conn: Connection; deviceId: string; onDone: () => void }) {
  const [running, setRunning] = useState(false);
  const [level, setLevel] = useState(0);
  const [left, setLeft] = useState(0);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopRef.current?.(), []);

  const run = async () => {
    setResult(null);
    setRunning(true);
    let stream: MediaStream | null = null;
    let ac: AudioContext | null = null;
    let raf = 0;
    const finish = (r: { ok: boolean; text: string } | null) => {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ac?.close().catch(() => undefined);
      stopRef.current = null;
      setRunning(false);
      setLevel(0);
      if (r) setResult(r);
      onDone();
    };
    stopRef.current = () => finish(null);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(deviceId) });
      const track = stream.getAudioTracks()[0];
      micLog(conn, `teste: getUserMedia ok (${track?.label || "?"}, muted=${track?.muted})`);
      ac = new AudioContext();
      const an = ac.createAnalyser();
      an.fftSize = 1024;
      ac.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const t0 = performance.now();
      let peak = 0;
      const tick = () => {
        an.getByteTimeDomainData(buf);
        const l = rmsLevel(buf);
        peak = Math.max(peak, l);
        setLevel(l);
        const el = performance.now() - t0;
        setLeft(Math.max(0, Math.ceil((5000 - el) / 1000)));
        if (el >= 5000) {
          const v = testVerdict(peak);
          micLog(conn, `teste: pico ${peak.toFixed(3)} => ${v.ok ? "ok" : "sem sinal"}`);
          finish({ ...v, text: `${v.text} · ${track?.label || "microfone"}` });
        } else raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    } catch (e) {
      const name = (e as DOMException).name;
      micLog(conn, `teste: getUserMedia erro ${name}`);
      finish({ ok: false, text: `${micErrorMessage(name)} (${name})` });
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        className="flex items-center gap-1 rounded bg-bg-hover px-2.5 py-1 text-[12px] text-text-1 hover:bg-border disabled:opacity-60"
        disabled={running}
        onClick={() => void run()}
      >
        {running ? <Loader2 size={12} className="animate-spin" /> : <Activity size={12} />}
        {running ? `Testando… fale algo (${left} s)` : "Testar microfone"}
      </button>
      {running && <LevelBar level={level} className="w-40" />}
      {result && <span className={cn("text-[12px]", result.ok ? "text-status-ok" : "text-status-err")}>{result.text}</span>}
    </div>
  );
}

export function LevelBar({ level, className }: { level: number; className?: string }) {
  return (
    <div className={cn("h-2 overflow-hidden rounded bg-bg-hover", className)} title="Nível do microfone">
      <div
        className={cn("h-full rounded transition-[width] duration-75", level > 0.6 ? "bg-status-warn" : "bg-status-ok")}
        style={{ width: `${Math.round(Math.min(1, level) * 100)}%` }}
      />
    </div>
  );
}
