import type { SocketState, StatusEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  socket: SocketState;
  status: StatusEvent | null;
}

/** LED + rotulo: verde = conectado, azul = conectando, vermelho = fora. */
export function StatusIndicator({ socket, status }: Props) {
  let tone: "ok" | "busy" | "err";
  let label: string;
  if (socket !== "open") {
    tone = socket === "connecting" ? "busy" : "err";
    label = socket === "connecting" ? "Conectando…" : "Desconectado";
  } else if (!status || status.state === "starting") {
    tone = "busy";
    label = "Iniciando ponte…";
  } else if (status.state === "up") {
    tone = "ok";
    label = "Conectado ao Beth Studio";
  } else {
    tone = "err";
    label = "Beth Studio indisponível";
  }
  return (
    <div className="flex items-center gap-2 rounded-md bg-bg-card px-2.5 py-1" title={status?.message ?? label}>
      <span
        className={cn(
          "h-2.5 w-2.5 rounded-full",
          tone === "ok" && "bg-status-ok",
          tone === "busy" && "animate-led-pulse bg-status-busy",
          tone === "err" && "bg-status-err",
        )}
      />
      <span className="text-[12px] text-text-1">{label}</span>
    </div>
  );
}
