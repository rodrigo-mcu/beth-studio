import { useRef, type MouseEvent as ReactMouseEvent } from "react";

interface Props {
  /** Linhas acima da tela viva sendo mostradas (0 = ao vivo, no fim). */
  offset: number;
  /** Linhas de historico acima da tela viva. */
  scrollback: number;
  rows: number;
  onScrollTo: (offset: number) => void;
}

/**
 * Barra de rolagem vertical do historico do host. Arrastar o polegar rola;
 * clicar na trilha acima/abaixo dele sobe/desce uma tela.
 */
export function ScrollBar({ offset, scrollback, rows, onScrollTo }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const total = scrollback + rows;
  const thumbPct = Math.max(2, (rows / total) * 100);
  // posicao 0 = topo do historico, 1 = fim (ao vivo)
  const pos = scrollback > 0 ? 1 - offset / scrollback : 1;
  const thumbStyle = {
    height: `max(24px, ${thumbPct}%)`,
    top: `calc((100% - max(24px, ${thumbPct}%)) * ${pos})`,
  };

  const offsetAt = (clientY: number, grab: number) => {
    const track = trackRef.current!;
    const r = track.getBoundingClientRect();
    const thumbH = Math.max(24, (thumbPct / 100) * r.height);
    const free = Math.max(1, r.height - thumbH);
    const p = Math.max(0, Math.min(1, (clientY - r.top - grab) / free));
    return Math.round((1 - p) * scrollback);
  };

  const onThumbDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const grab = e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top;
    const move = (ev: MouseEvent) => onScrollTo(offsetAt(ev.clientY, grab));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const onTrackDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const thumb = (e.currentTarget as HTMLElement).firstElementChild as HTMLElement | null;
    const tr = thumb?.getBoundingClientRect();
    if (tr && e.clientY < tr.top) onScrollTo(offset + rows);
    else if (tr && e.clientY > tr.bottom) onScrollTo(offset - rows);
  };

  return (
    <div
      ref={trackRef}
      className="group absolute bottom-1 right-1 top-1 w-3 cursor-pointer rounded-full bg-white/5 hover:bg-white/10"
      onMouseDown={onTrackDown}
      onContextMenu={(e) => e.stopPropagation()}
      title={offset > 0 ? `${offset} linhas acima do fim (de ${scrollback})` : `Histórico: ${scrollback} linhas`}
    >
      <div
        className="absolute left-0.5 right-0.5 rounded-full bg-text-2/50 group-hover:bg-text-2/80"
        style={thumbStyle}
        onMouseDown={onThumbDown}
      />
    </div>
  );
}
