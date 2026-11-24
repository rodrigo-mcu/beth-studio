import type { Connection } from "@/lib/connection";
import type { HostBannerInfo } from "@/lib/hostBanner";
import { dragMacWindow, isMacTitlebar } from "@/lib/windowFrame";
import { cn } from "@/lib/utils";

/** Faixa no alto do Studio quando o host não está de pé e o Studio não consegue subi-lo.
 *  No macOS ela começa abaixo dos semáforos, senão o aviso cobre os botões
 *  e o arraste da janela não chega. */
export function HostBanner({ conn, info }: { conn: Connection; info: HostBannerInfo }) {
  return (
    <div
      role="alert"
      className={cn(
        "flex shrink-0 items-center gap-3 rounded-t-xl border-b border-status-err/40 bg-status-err/15 px-3 py-1.5 text-[13px] text-text-1",
        false && "mt-7",
      )}
      onMouseDown={(e) => {
        if (!isMacTitlebar() || e.button !== 0) return;
        if ((e.target as Element).closest("button")) return;
        dragMacWindow();
      }}
    >
      <span className="min-w-0 flex-1">{info.text}</span>
      {info.retry && (
        <button
          className="shrink-0 rounded bg-accent px-3 py-1 text-white hover:bg-accent-hover"
          onClick={() => void conn.api("/api/host/retry", {}).catch(() => undefined)}
        >
          Tentar de novo
        </button>
      )}
    </div>
  );
}
