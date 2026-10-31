import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { CLIP_LEVEL } from "@/lib/micTuning";
import { cn } from "@/lib/utils";

export interface ScopeHandle {
  /** Um quadro de medição: pico e RMS do instante (0..1) e o pico retido. */
  push(peak: number, rms: number, hold: number): void;
  clear(): void;
}

interface Bar {
  peak: number;
  rms: number;
}

const BAR_PX = 3;
const GAP_PX = 1;
/** Uma barra nova a cada tanto: ~5 s de histórico na largura típica. */
const BAR_MS = 50;

const GREEN = "34,197,94";
const AMBER = "245,158,11";
const RED = "220,38,38";

const tone = (v: number) => (v >= CLIP_LEVEL ? RED : v >= 0.75 ? AMBER : GREEN);

/**
 * Onda rolando no tempo (espelhada no centro), com o RMS por dentro do pico
 * e uma linha de pico retido. Desenha direto no canvas: sem estado do React
 * por quadro.
 */
export const LevelScope = forwardRef<ScopeHandle, { className?: string }>(function LevelScope({ className }, ref) {
  const cv = useRef<HTMLCanvasElement>(null);
  const bars = useRef<Bar[]>([]);
  const acc = useRef<Bar & { at: number }>({ peak: 0, rms: 0, at: 0 });
  const holdRef = useRef(0);

  const draw = () => {
    const c = cv.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const g = c.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, w, h);
    const mid = h / 2;
    const step = (BAR_PX + GAP_PX) * dpr;
    const bw = BAR_PX * dpr;
    const cap = Math.floor(w / step);

    // linha do centro e faixa de saturação
    g.fillStyle = getComputedStyle(c).color;
    g.globalAlpha = 0.18;
    g.fillRect(0, Math.round(mid), w, Math.max(1, Math.round(dpr)));
    g.globalAlpha = 0.1;
    const clipH = (1 - CLIP_LEVEL) * mid;
    g.fillStyle = `rgb(${RED})`;
    g.fillRect(0, 0, w, clipH);
    g.fillRect(0, h - clipH, w, clipH);
    g.globalAlpha = 1;

    const list = bars.current.slice(-cap);
    // a barra mais nova encosta na direita
    let x = w - list.length * step;
    for (const b of list) {
      const ph = Math.max(dpr, b.peak * mid);
      g.fillStyle = `rgba(${tone(b.peak)},0.4)`;
      g.fillRect(x, mid - ph, bw, ph * 2);
      const rh = Math.max(dpr, Math.min(b.rms, b.peak) * mid);
      g.fillStyle = `rgb(${tone(b.peak)})`;
      g.fillRect(x, mid - rh, bw, rh * 2);
      x += step;
    }

    // pico retido
    const hold = holdRef.current;
    if (hold > 0.01) {
      const y = hold * mid;
      g.fillStyle = `rgb(${tone(hold)})`;
      g.globalAlpha = 0.9;
      const t = Math.max(1, Math.round(dpr));
      g.fillRect(0, mid - y, w, t);
      g.fillRect(0, mid + y - t, w, t);
      g.globalAlpha = 1;
    }
  };

  useImperativeHandle(ref, () => ({
    push(peak, rms, hold) {
      const now = performance.now();
      const a = acc.current;
      a.peak = Math.max(a.peak, peak);
      a.rms = Math.max(a.rms, rms);
      holdRef.current = hold;
      if (!a.at) a.at = now;
      if (now - a.at >= BAR_MS) {
        bars.current.push({ peak: a.peak, rms: a.rms });
        if (bars.current.length > 600) bars.current.splice(0, bars.current.length - 600);
        a.peak = 0;
        a.rms = 0;
        a.at = now;
      }
      draw();
    },
    clear() {
      bars.current = [];
      acc.current = { peak: 0, rms: 0, at: 0 };
      holdRef.current = 0;
      draw();
    },
  }));

  useEffect(() => {
    draw();
    const c = cv.current;
    if (!c || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  return (
    <canvas
      ref={cv}
      className={cn("block h-20 w-full rounded bg-bg-term text-text-1", className)}
      title="Onda do microfone: barra = pico, miolo = volume médio, linha = pico retido; o topo vermelho é a saturação"
    />
  );
});
