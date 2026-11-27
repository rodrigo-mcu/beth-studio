/**
 * Panes que a página pede à ponte. O Go aceita no máximo MAX_WATCH por página
 * (server.go, op "watch"); acima disso ele corta pela ordem numérica. Por isso
 * os terminais visíveis entram sempre, e os agentes de outras abas (só para o
 * estado rodando/pronto na lista) ocupam as vagas que sobrarem.
 */
export const MAX_WATCH = 16;

export function watchSet(visible: number[], agents: number[], max = MAX_WATCH): number[] {
  const out: number[] = [];
  for (const id of [...visible, ...agents]) {
    if (out.length >= max) break;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}
