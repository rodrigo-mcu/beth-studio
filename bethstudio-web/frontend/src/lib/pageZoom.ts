// Zoom da tela inteira (Ctrl + roda / Ctrl +/- no WebView2). O Go lê o fator
// (webview_zoom_windows.go) e o devolve por window.__bethstudioZoom(fator);
// "zoom:reset" volta a 100%. Fora da janela do app (navegador, celular) não
// há resposta e o indicador nunca aparece. Testado em tests/pageZoom.test.ts.

import { useEffect, useState } from "react";

declare global {
  interface Window {
    __bethstudioZoom?: (factor: number) => void;
  }
}

/** Dentro de 0,5% de 100% conta como 100% (o fator vem em ponto flutuante). */
export function isDefaultZoom(f: number): boolean {
  return Math.abs(f - 1) < 0.005;
}

export function zoomLabel(f: number): string {
  return `${Math.round(f * 100)}%`;
}

let current = 1;
const listeners = new Set<(f: number) => void>();
let hooked = false;

function ask() {
  window.chrome?.webview?.postMessage("zoom:get");
}

function hookOnce() {
  if (hooked || typeof window === "undefined" || !window.chrome?.webview) return;
  hooked = true;
  window.__bethstudioZoom = (f) => {
    if (!Number.isFinite(f) || f <= 0) return;
    current = f;
    listeners.forEach((l) => l(f));
  };
  // zoom muda o tamanho útil da janela e o devicePixelRatio: pergunta de novo
  window.addEventListener("resize", ask);
  ask();
}

export function resetPageZoom() {
  window.chrome?.webview?.postMessage("zoom:reset");
}

/** Fator de zoom atual da tela (1 = 100%). */
export function usePageZoom(): number {
  const [f, setF] = useState(current);
  useEffect(() => {
    hookOnce();
    listeners.add(setF);
    setF(current);
    return () => {
      listeners.delete(setF);
    };
  }, []);
  return f;
}
