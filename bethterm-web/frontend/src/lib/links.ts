// Caminho único para links http(s): qualquer link (na própria UI do app, ou
// detectado na saída do terminal) que precise abrir num navegador abre
// SEMPRE no navegador padrão do sistema, nunca dentro da janela do
// BethTerm. A rota /api/open-link (weblinks.go) faz a abertura de verdade;
// aqui só validamos e chamamos o Go — nunca fazemos window.open com a URL
// remota (o WebView2 já bloqueia popups de qualquer forma, ver
// webhost_windows.go, mas não confiamos só nisso).
import type { Connection } from "./connection.ts";
import { isRemote } from "./remote.ts";

/** http(s) com host — mesma regra do Go em weblinks.go (validação dupla, cliente + servidor). */
export function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") && u.host !== "";
  } catch {
    return false;
  }
}

/** Abre no navegador padrão do sistema via Go. Nunca abre dentro do app. */
export async function openExternal(conn: Connection, url: string): Promise<void> {
  if (!isHttpUrl(url)) return;
  // Studio remoto: abre no navegador de quem está usando, não no PC.
  if (isRemote()) {
    nativeOpen(url, "_blank", "noopener,noreferrer");
    return;
  }
  await conn.api<{ url: string }>("/api/open-link", { url });
}

function closestAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest("a[href]");
}

let installed = false;
let nativeOpen: typeof window.open = (...a) => window.open(...a);

/**
 * Instala, uma única vez, um interceptador global (fase de captura) que
 * pega qualquer <a href> da própria UI do app — clique normal, Ctrl+clique,
 * clique do meio (abre em nova aba) — e um bloqueio de window.open, e
 * redireciona tudo para openExternal em vez de deixar o WebView2 navegar ou
 * abrir uma janela nova.
 */
export function installLinkGuard(conn: Connection) {
  if (installed) return;
  installed = true;

  const route = (raw: string, ev: Event) => {
    if (!isHttpUrl(raw)) return false;
    ev.preventDefault();
    ev.stopPropagation();
    void openExternal(conn, raw);
    return true;
  };

  window.addEventListener(
    "click",
    (ev) => {
      const a = closestAnchor(ev.target);
      if (!a) return;
      route(a.href, ev);
    },
    true,
  );

  // clique do meio / botao auxiliar (auxclick nao dispara "click")
  window.addEventListener(
    "auxclick",
    (ev) => {
      if (ev.button !== 1) return;
      const a = closestAnchor(ev.target);
      if (!a) return;
      route(a.href, ev);
    },
    true,
  );

  const w = window as unknown as { open: typeof window.open };
  const originalOpen = w.open.bind(window);
  nativeOpen = originalOpen;
  w.open = ((url?: string | URL, target?: string, features?: string) => {
    const raw = url == null ? "" : url.toString();
    if (isHttpUrl(raw)) {
      void openExternal(conn, raw);
      return null;
    }
    return originalOpen(url, target, features);
  }) as typeof window.open;
}

/** Só para teste: permite reinstalar o guard entre casos. */
export function _resetLinkGuardForTests() {
  installed = false;
}
