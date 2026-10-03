// Busca no histórico geral de consultas: separa o texto em pedaços "com
// realce" e "sem realce" para os termos digitados. Testado em tests/dbHistory.test.ts.

export interface Piece {
  text: string;
  hit: boolean;
}

/** Termos da busca: separados por espaço, sem diferenciar maiúsculas. */
export function searchTerms(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** Divide `text` marcando onde algum termo aparece (os pedaços juntos formam o texto original). */
export function highlightPieces(text: string, terms: string[]): Piece[] {
  if (!terms.length || !text) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const hits: [number, number][] = [];
  for (const t of terms) {
    let i = 0;
    while ((i = lower.indexOf(t, i)) >= 0) {
      hits.push([i, i + t.length]);
      i += t.length;
    }
  }
  if (!hits.length) return [{ text, hit: false }];
  hits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && h[0] <= last[1]) last[1] = Math.max(last[1], h[1]);
    else merged.push([h[0], h[1]]);
  }
  const out: Piece[] = [];
  let pos = 0;
  for (const [a, b] of merged) {
    if (a > pos) out.push({ text: text.slice(pos, a), hit: false });
    out.push({ text: text.slice(a, b), hit: true });
    pos = b;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}

/** SQL numa linha só, para a lista (quebras e recuos viram espaço). */
export function oneLine(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}
