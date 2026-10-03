import { Fragment, useRef, useState, type DragEvent as RDragEvent, type MouseEvent as RMouseEvent, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import type { LayoutNode, Path, Zone } from "@/lib/layout";
import { PANE_MIME, draggedPane, endDrag, useDrag } from "@/lib/dnd";
import { cn } from "@/lib/utils";

interface Props {
  node: LayoutNode;
  path?: Path;
  /** desenha uma folha viva (TerminalView); `overlay` = zonas de soltar */
  renderLeaf: (pane: number, path: Path, overlay: ReactNode) => ReactNode;
  /** folha de um terminal que sumiu do host */
  renderGone: (pane: number, path: Path, title?: string, cwd?: string) => ReactNode;
  /** tamanhos ao vivo (arrastando) e ao soltar a divisoria (commit=true) */
  onSizes: (path: Path, sizes: number[], commit: boolean) => void;
  onDropPane: (pane: number, targetPane: number, zone: Zone) => void;
}

/** Arvore de splits do web, com divisorias arrastaveis. */
export function SplitView(p: Props) {
  const { node, path = [] } = p;
  if (node.type === "leaf") {
    if (node.gone) return <>{p.renderGone(node.pane, path, node.title, node.cwd)}</>;
    return <>{p.renderLeaf(node.pane, path, <DropZones pane={node.pane} onDrop={p.onDropPane} />)}</>;
  }
  return <SplitBox {...p} node={node} path={path} />;
}

function SplitBox(p: Props & { node: Extract<LayoutNode, { type: "split" }>; path: Path }) {
  const { node, path } = p;
  const box = useRef<HTMLDivElement>(null);
  const row = node.dir === "row";

  const startResize = (i: number, e: RMouseEvent) => {
    e.preventDefault();
    const el = box.current!;
    const r = el.getBoundingClientRect();
    const total = row ? r.width : r.height;
    const start = row ? e.clientX : e.clientY;
    const s0 = node.sizes.slice();
    const pair = s0[i] + s0[i + 1];
    const min = Math.min(0.06, pair / 3);
    let last = s0;
    const move = (ev: MouseEvent) => {
      const d = ((row ? ev.clientX : ev.clientY) - start) / Math.max(1, total);
      const a = Math.max(min, Math.min(pair - min, s0[i] + d));
      last = s0.slice();
      last[i] = a;
      last[i + 1] = pair - a;
      p.onSizes(path, last, false);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      p.onSizes(path, last, true);
    };
    document.body.style.cursor = row ? "col-resize" : "row-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div ref={box} className={cn("flex min-h-0 min-w-0 flex-1", row ? "flex-row" : "flex-col")}>
      {node.children.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <div
              className={cn(
                "group relative shrink-0 bg-transparent",
                row ? "w-2 cursor-col-resize" : "h-2 cursor-row-resize",
              )}
              onMouseDown={(e) => startResize(i - 1, e)}
              onDoubleClick={() => {
                const s = node.sizes.slice();
                const pair = s[i - 1] + s[i];
                s[i - 1] = s[i] = pair / 2;
                p.onSizes(path, s, true);
              }}
              title="Arraste para redimensionar (duplo clique iguala)"
            >
              <div className={cn("absolute rounded bg-border group-hover:bg-accent", row ? "inset-y-1 left-[3px] w-0.5" : "inset-x-1 top-[3px] h-0.5")} />
            </div>
          )}
          <div className="flex min-h-0 min-w-0" style={{ flex: `${node.sizes[i]} 1 0px` }}>
            <SplitView {...p} node={c} path={[...path, i]} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/** Zonas de soltar sobre um terminal: bordas dividem, centro troca. */
function DropZones({ pane, onDrop }: { pane: number; onDrop: (pane: number, target: number, zone: Zone) => void }) {
  const drag = useDrag();
  const [zone, setZone] = useState<Zone | null>(null);
  if (drag?.kind !== "pane" || drag.pane === pane) return null;

  const zoneAt = (e: RDragEvent): Zone => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const d = Math.min(x, 1 - x, y, 1 - y);
    if (d > 0.25) return "center";
    if (d === x) return "left";
    if (d === 1 - x) return "right";
    if (d === y) return "top";
    return "bottom";
  };
  const hl: Record<Zone, string> = {
    left: "left-0 top-0 bottom-0 w-1/2",
    right: "right-0 top-0 bottom-0 w-1/2",
    top: "left-0 right-0 top-0 h-1/2",
    bottom: "left-0 right-0 bottom-0 h-1/2",
    center: "inset-[20%]",
  };
  const label: Record<Zone, string> = {
    left: "Dividir à esquerda",
    right: "Dividir à direita",
    top: "Dividir acima",
    bottom: "Dividir abaixo",
    center: "Trocar de lugar",
  };
  return (
    <div
      className="absolute inset-0 z-30"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(PANE_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const z = zoneAt(e);
        if (z !== zone) setZone(z);
      }}
      onDragLeave={() => setZone(null)}
      onDrop={(e) => {
        e.preventDefault();
        const p = draggedPane(e);
        const z = zoneAt(e);
        setZone(null);
        endDrag();
        if (p !== null) onDrop(p, pane, z);
      }}
    >
      {zone && (
        <div className={cn("pointer-events-none absolute flex items-center justify-center rounded border-2 border-accent bg-accent/25", hl[zone])}>
          <span className="rounded bg-bg-card px-2 py-1 text-[12px] text-text-1 shadow">{label[zone]}</span>
        </div>
      )}
    </div>
  );
}

/** Marcador de um terminal que sumiu do host. */
export function GoneLeaf({ title, cwd, onRemove }: { title?: string; cwd?: string; onRemove: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-bg-panel/60 p-4 text-center text-text-3">
      <div className="text-text-2">{title || "Terminal"}</div>
      {cwd && <div className="max-w-full truncate font-mono text-[11px]">{cwd}</div>}
      <div className="text-[12px]">terminal encerrado</div>
      <button className="flex items-center gap-1.5 rounded bg-bg-hover px-3 py-1 text-text-1 hover:bg-border" onClick={onRemove}>
        <Trash2 size={13} /> Remover
      </button>
    </div>
  );
}
