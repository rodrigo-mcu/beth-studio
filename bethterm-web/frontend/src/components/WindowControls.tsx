import { isFrameless, winCommand, type WinState } from "@/lib/windowFrame";
import { cn } from "@/lib/utils";

/** ─ □/❐ ✕ desenhados na barra de abas (46×32, como no Windows 11).
 * onClose troca o ✕: a tela de banco fecha só o painel, não o Beth Studio. */
export function WindowControls({ state, onClose, closeTitle = "Fechar" }: { state: WinState; onClose?: () => void; closeTitle?: string }) {
  if (!isFrameless()) return null;
  const btn = "flex h-7 w-[42px] shrink-0 items-center justify-center text-text-2 transition-colors";
  return (
    <div className={cn("-mr-2 -mt-1 flex shrink-0 self-start", !state.active && "opacity-60")} data-no-drag>
      <button className={cn(btn, "hover:bg-bg-hover hover:text-text-1")} title="Minimizar" onClick={() => winCommand("min")}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button
        className={cn(btn, "hover:bg-bg-hover hover:text-text-1")}
        title={state.max ? "Restaurar" : "Maximizar"}
        onClick={() => winCommand("toggle")}
      >
        {state.max ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M2.5 2.5V0.5h7v7h-2M0.5 2.5h7v7h-7z" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>
      <button className={cn(btn, "hover:bg-[#C42B1C] hover:text-white")} title={closeTitle} onClick={() => (onClose ? onClose() : winCommand("close"))}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}

/** Topo da janela (4 px) para redimensionar: a WebView2 cobre a janela toda. */
export function TopResizeEdges({ state }: { state: WinState }) {
  if (!isFrameless() || state.max) return null;
  return (
    <>
      <div className="fixed left-2 right-2 top-0 z-[200] h-1 cursor-ns-resize" onMouseDown={(e) => e.button === 0 && winCommand("resize:top")} />
      <div className="fixed left-0 top-0 z-[200] h-2 w-2 cursor-nwse-resize" onMouseDown={(e) => e.button === 0 && winCommand("resize:topleft")} />
      <div className="fixed right-0 top-0 z-[200] h-2 w-2 cursor-nesw-resize" onMouseDown={(e) => e.button === 0 && winCommand("resize:topright")} />
    </>
  );
}
