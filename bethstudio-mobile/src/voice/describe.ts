// O que a tela mostra de cada gravação da fila: título, linha de estado e
// botões. Puro, para a regra "falhou => Tentar de novo / Baixar / Descartar"
// ficar testada fora do React.

import { MAX_ATTEMPTS } from "./retry";
import type { Take } from "./queue";

export type TakeAction = "sendNow" | "retry" | "download" | "discard" | "place" | "copy";

export interface TakeView {
  title: string;
  detail: string;
  /** texto pronto (só no estado "ready") */
  preview: string | null;
  actions: TakeAction[];
}

/** 0:07, 1:32 */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function describeTake(t: Take, now: number): TakeView {
  const title = `Áudio de ${clock(t.seconds * 1000)}`;
  switch (t.status) {
    case "recording":
      return { title, detail: "A gravação foi interrompida. O que já foi gravado está guardado.", preview: null, actions: ["sendNow", "discard"] };
    case "sending":
      return { title, detail: "Enviando para o PC…", preview: null, actions: [] };
    case "pending": {
      if (t.attempts === 0) return { title, detail: "Na fila para enviar ao PC.", preview: null, actions: ["sendNow", "discard"] };
      const left = Math.ceil((t.nextAttemptAt - now) / 1000);
      const when = left > 0 ? `em ${left} s` : "agora";
      return {
        title,
        detail: `Sem resposta do PC. Tentando de novo ${when} (tentativa ${t.attempts} de ${MAX_ATTEMPTS}). O áudio está guardado.`,
        preview: null,
        actions: ["sendNow", "discard"],
      };
    }
    case "failed":
      return {
        title,
        detail: `${t.lastError ?? "Não foi possível enviar."} O áudio está guardado.`,
        preview: null,
        actions: ["retry", "download", "discard"],
      };
    case "ready":
      return { title: "Texto pronto", detail: "O texto ainda não entrou no campo de mensagem.", preview: t.text, actions: ["place", "copy", "discard"] };
  }
}
