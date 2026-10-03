// Devolver o foco a um terminal depois de um popup (ex. "Falar"): cada
// TerminalView se registra aqui; quem fecha o popup chama returnFocus.
// Testado em tests/termFocus.test.ts.

export interface TermHandle {
  focus: () => void;
  /** volta para a tela ao vivo (fim) */
  toEnd: () => void;
}

const registry = new Map<number, TermHandle>();

export function registerTerm(pane: number, h: TermHandle): () => void {
  registry.set(pane, h);
  return () => {
    if (registry.get(pane) === h) registry.delete(pane);
  };
}

export function termHandle(pane: number): TermHandle | undefined {
  return registry.get(pane);
}

type Sched = (f: () => void) => void;
const defaultRaf: Sched = (f) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => f()) : setTimeout(f, 16));

/**
 * Depois que o popup desmontar: ativa a aba do terminal (activate), espera
 * um quadro + um tick (o foco do modal nao pode ganhar) e foca o xterm,
 * rolando para o fim. Tenta de novo por ~0,5 s se o terminal ainda nao
 * montou (aba recem-ativada).
 */
export function returnFocus(pane: number, activate: () => void, raf: Sched = defaultRaf, tick: Sched = (f) => setTimeout(f, 0)): void {
  activate();
  let tries = 0;
  const attempt = () => {
    const h = registry.get(pane);
    if (h) {
      h.toEnd();
      h.focus();
      return;
    }
    if (++tries < 10) setTimeout(attempt, 50);
  };
  raf(() => tick(attempt));
}

/**
 * Terminal em foco por aba (App.focus). Chamado no clique E no focusin do
 * terminal: se o cursor chegou ao terminal sem clique (Falar, lista lateral,
 * split novo), o microfone da barra de abas ainda precisa apontar para ele.
 * Sem mudanca devolve o mesmo objeto (o React nao re-renderiza).
 */
export function withTabFocus(f: Record<string, number>, tabId: string, pane: number): Record<string, number> {
  return f[tabId] === pane ? f : { ...f, [tabId]: pane };
}
