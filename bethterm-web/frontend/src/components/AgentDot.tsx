import type { AgentInfo } from "@/lib/agents";
import { reasonLabel } from "@/lib/agents";
import { cn } from "@/lib/utils";

/** Ponto ambar pulsando: um agente neste terminal espera o usuario. */
export function AgentDot({ agent, className }: { agent: AgentInfo; className?: string }) {
  return (
    <span
      className={cn("relative inline-flex h-2.5 w-2.5 shrink-0", className)}
      title={`Agente aguardando resposta (${reasonLabel(agent)})`}
    >
      <span className="absolute inset-0 animate-ping rounded-full bg-status-warn opacity-60" />
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-status-warn" />
    </span>
  );
}
