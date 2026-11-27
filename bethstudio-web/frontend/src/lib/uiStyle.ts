import { useSyncExternalStore } from "react";

/**
 * Estilo da interface (Configurações > Aparência): "Original" é o visual da
 * 0.4.1 (abas baixas, barra lateral compacta, menus sem vidro); "Mac" é o
 * visual em cartões. Os componentes escolhem as classes de cada um com
 * useOriginalStyle(); o CSS do Original fica em index.css (bt-style-original).
 */
let original = false;
const subs = new Set<() => void>();

export function setOriginalStyle(on: boolean) {
  if (typeof document !== "undefined") document.documentElement.classList.toggle("bt-style-original", on);
  if (on === original) return;
  original = on;
  subs.forEach((f) => f());
}

export function isOriginalStyle(): boolean {
  return original;
}

export function useOriginalStyle(): boolean {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => original,
  );
}
