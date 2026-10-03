import { useEffect, useRef, useState } from "react";
import type { AgentState } from "./agents";
import { reasonLabel } from "./agents";
import type { PaneInfo } from "./types";
import { paneLabel } from "./panes";

// Avisos opcionais quando um agente passa a aguardar (desligados por
// padrao; ligados em Aparencia geral). Preferencia por navegador
// (localStorage): e' uma conveniencia de quem esta' olhando.

export interface NotifyPrefs {
  os: boolean; // notificacao do Windows (Notification API do WebView2)
  sound: boolean;
}

const KEY = "bethterm-web.notify";

export function useNotifyPrefs(): [NotifyPrefs, (p: NotifyPrefs) => void] {
  const [p, setP] = useState<NotifyPrefs>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
      return { os: !!v.os, sound: !!v.sound };
    } catch {
      return { os: false, sound: false };
    }
  });
  const set = (n: NotifyPrefs) => {
    setP(n);
    try {
      localStorage.setItem(KEY, JSON.stringify(n));
    } catch {
      /* ignora */
    }
    if (n.os && typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => undefined);
    }
  };
  return [p, set];
}

let audio: AudioContext | null = null;
export function beep() {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, audio.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.35);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.4);
  } catch {
    /* sem audio */
  }
}

/** Dispara notificacao/som quando um pane PASSA a aguardar. */
export function useAgentAlerts(agents: AgentState, panes: PaneInfo[] | null, prefs: NotifyPrefs) {
  const prev = useRef<Set<number> | null>(null);
  useEffect(() => {
    const now = new Set(Object.keys(agents).map(Number));
    const before = prev.current;
    prev.current = now;
    if (!before) return; // primeira carga: nao avisa o que ja' estava
    const fresh = [...now].filter((p) => !before.has(p));
    if (fresh.length === 0 || (!prefs.os && !prefs.sound)) return;
    if (prefs.sound) beep();
    if (prefs.os && typeof Notification !== "undefined" && Notification.permission === "granted") {
      for (const id of fresh.slice(0, 3)) {
        const info = panes?.find((p) => p.pane_id === id);
        try {
          new Notification("Agente aguardando resposta", {
            body: `${info ? paneLabel(info) : `Terminal ${id}`} — ${reasonLabel(agents[id])}`,
            tag: `bethterm-agent-${id}`,
          });
        } catch {
          /* sem notificacao */
        }
      }
    }
  }, [agents, panes, prefs]);
}
