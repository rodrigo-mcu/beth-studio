import type { ReactNode } from "react";
import { isFrameless, startDrag, useWindowState, winCommand } from "@/lib/windowFrame";
import { cn } from "@/lib/utils";

/** Icone do Beth Studio (o mesmo do exe), nitido em 16 px e em DPI alto. */
export function AppLogo({ className }: { className?: string }) {
  return (
    <img
      src="./bethstudio-16.png"
      srcSet="./bethstudio-16.png 1x, ./bethstudio-32.png 2x, ./bethstudio-48.png 3x, ./bethstudio-64.png 4x"
      width={16}
      height={16}
      alt=""
      draggable={false}
      className={cn("h-4 w-4 shrink-0", className)}
    />
  );
}

/**
 * Faixa de titulo no topo da barra lateral (mesma altura da barra de abas):
 * logo + "Beth Studio"; so' o logo com a barra recolhida. Arrasta a janela e o
 * duplo clique maximiza (so' na janela do app).
 */
export function AppTitle({ compact, right }: { compact?: boolean; right?: ReactNode }) {
  const win = useWindowState();
  const frameless = isFrameless();
  return (
    <div
      className={cn(
        "flex h-7 w-full shrink-0 select-none items-center gap-2 border-b border-border",
        compact ? "justify-center" : "px-3",
        frameless && !win.active && "opacity-75",
      )}
      onMouseDown={startDrag}
      onDoubleClick={() => frameless && winCommand("toggle")}
      title={frameless ? "Beth Studio — arraste para mover a janela; duplo clique maximiza" : "Beth Studio"}
    >
      <AppLogo />
      {!compact && <span className="truncate text-[13px] font-semibold text-text-1">Beth Studio</span>}
      {!compact && right && (
        <span className="ml-auto shrink-0" data-no-drag onMouseDown={(e) => e.stopPropagation()}>
          {right}
        </span>
      )}
    </div>
  );
}
