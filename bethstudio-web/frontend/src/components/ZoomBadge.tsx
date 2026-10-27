import { RotateCcw } from "lucide-react";
import { isDefaultZoom, resetPageZoom, usePageZoom, zoomLabel } from "@/lib/pageZoom";

/** Aviso no canto da tela quando o zoom (Ctrl + roda) não está em 100%. */
export function ZoomBadge() {
  const f = usePageZoom();
  if (isDefaultZoom(f)) return null;
  return (
    <button
      className="fixed bottom-2 right-2 z-[70] flex items-center gap-1.5 rounded-full border border-border-strong bg-bg-card px-2.5 py-1 text-[12px] font-semibold text-text-1 shadow-lg hover:bg-bg-hover"
      title="O zoom da tela não está em 100%. Clique para voltar (ou Ctrl+0)"
      onClick={resetPageZoom}
    >
      Zoom {zoomLabel(f)}
      <RotateCcw size={12} />
    </button>
  );
}
