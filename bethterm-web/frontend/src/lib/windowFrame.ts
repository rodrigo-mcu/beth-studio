// Janela sem a barra de titulo nativa (so' na janela do app, WebView2): a
// barra de abas vira a barra de titulo. As acoes vao para o Go por
// window.chrome.webview.postMessage("win:...") (winframe_windows.go) e o Go
// avisa o estado (maximizada, ativa) por window.__bethtermWin(max, active).

import { useEffect, useState } from "react";

declare global {
  interface Window {
    __bethtermFrameless?: boolean;
    __bethtermWin?: (max: boolean, active: boolean) => void;
    chrome?: { webview?: { postMessage: (m: string) => void } };
  }
}

export type WinCommand = "drag" | "toggle" | "min" | "close" | "state" | "resize:top" | "resize:topleft" | "resize:topright";

/** Estamos na janela propria sem moldura? (no navegador comum/celular: nao) */
export function isFrameless(): boolean {
  return typeof window !== "undefined" && !!window.__bethtermFrameless && !!window.chrome?.webview;
}

export function winCommand(c: WinCommand) {
  window.chrome?.webview?.postMessage(`win:${c}`);
}

export interface WinState {
  max: boolean;
  active: boolean;
}

// Estado compartilhado (varios componentes usam; o Go chama uma funcao so').
let current: WinState = { max: false, active: true };
const listeners = new Set<(s: WinState) => void>();
let hooked = false;

function hookOnce() {
  if (hooked || !isFrameless()) return;
  hooked = true;
  window.__bethtermWin = (max, active) => {
    current = { max, active };
    listeners.forEach((l) => l(current));
  };
  winCommand("state");
}

/** Estado da janela (atualizado pelo Go). */
export function useWindowState(): WinState {
  const [s, setS] = useState<WinState>(current);
  useEffect(() => {
    hookOnce();
    listeners.add(setS);
    setS(current);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}

/**
 * mousedown numa area de arraste: so' botao esquerdo, e nunca a partir de
 * um controle (botao/aba/campo) dentro dela.
 */
export function startDrag(e: { button: number; target: EventTarget | null; currentTarget: EventTarget | null; detail: number }) {
  if (!isFrameless() || e.button !== 0 || e.detail > 1) return;
  if (e.target !== e.currentTarget && (e.target as Element | null)?.closest?.("button,input,[data-no-drag],[draggable=true]")) return;
  winCommand("drag");
}
