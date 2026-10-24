// A roda do mouse normalmente rola o histórico do host. Um programa em tela
// cheia (como o Claude no modo fullscreen) liga o rastreamento de mouse e não
// deixa histórico no host: a roda precisa ir para ele, que rola a própria tela.
export function wheelGoesToApp(s: { tracking: boolean; scrollback: number }): boolean {
  return s.tracking && s.scrollback <= 0;
}
