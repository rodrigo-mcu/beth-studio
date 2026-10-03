// Faixa "Host indisponível": o Studio vigia o host (supervisor.go) e avisa
// quando não consegue mantê-lo de pé. Testado em tests/hostBanner.test.ts.

export type HostState = "running" | "starting" | "unavailable" | "quitting" | "gui-managed" | "unmanaged";

export interface HostEvent {
  ev: "host";
  state: HostState;
  message: string;
}

export interface HostBannerInfo {
  text: string;
  /** mostra o botão "Tentar de novo" */
  retry: boolean;
}

/** O que mostrar para o estado do host (null = nada). */
export function hostBanner(h: HostEvent | null): HostBannerInfo | null {
  if (!h) return null;
  if (h.state === "unavailable") return { text: h.message || "O host está indisponível.", retry: true };
  // falha ao iniciar: o supervisor tenta de novo sozinho, mas o motivo vale mostrar
  if (h.state === "starting" && h.message && !h.message.startsWith("Iniciando")) return { text: h.message, retry: false };
  return null;
}
