import type { Connection } from "@/lib/connection";
import type { HostBannerInfo } from "@/lib/hostBanner";

/** Faixa no alto do Studio quando o host não está de pé e o Studio não consegue subi-lo. */
export function HostBanner({ conn, info }: { conn: Connection; info: HostBannerInfo }) {
  return (
    <div role="alert" className="flex shrink-0 items-center gap-3 border-b border-status-err/40 bg-status-err/10 px-3 py-1.5 text-[13px] text-text-1">
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
