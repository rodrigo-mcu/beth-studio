import { useState } from "react";
import type { RestoreBannerInfo } from "@/lib/restoreBanner";

/** Faixa no alto do Studio durante e depois da restauração dos terminais. */
export function RestoreBanner({ info, onDismiss }: { info: RestoreBannerInfo; onDismiss: () => void }) {
  const [open, setOpen] = useState(false);
  const failed = info.details.length > 0;
  return (
    <div
      role="status"
      className={
        "shrink-0 border-b px-3 py-1.5 text-[13px] text-text-1 " +
        (failed ? "border-status-warn/40 bg-status-warn/10" : "border-border bg-bg-card")
      }
    >
      <div className="flex items-center gap-3">
        {info.busy && <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-text-3/30 border-t-accent" />}
        <span className="min-w-0 flex-1">{info.text}</span>
        {failed && (
          <button className="shrink-0 text-accent hover:underline" onClick={() => setOpen((v) => !v)}>
            {open ? "Esconder detalhes" : "Ver detalhes"}
          </button>
        )}
        {!info.busy && (
          <button className="shrink-0 text-text-2 hover:text-text-1" onClick={onDismiss}>
            Fechar
          </button>
        )}
      </div>
      {failed && open && (
        <ul className="mt-1 list-disc pl-6 text-text-2">
          {info.details.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
