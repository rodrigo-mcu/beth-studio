// "Vocabulario tecnico padrao" do corretor de voz (lista mantida no Go,
// techvocab.go; aqui so' leitura e busca). Testado em tests/techVocab.test.ts.

import type { Connection } from "./connection";

export interface VocabCategory {
  name: string;
  terms: string[];
}

export interface TechVocab {
  categories: VocabCategory[];
  total: number;
  /** subconjunto curto que vai no prompt da transcricao */
  top: string[];
  /** exemplos foneticos do prompt da correcao */
  phonetic: { heard: string; term: string }[];
}

export const loadTechVocab = (conn: Connection) => conn.api<TechVocab>("/api/voice/tech-vocab");

function fold(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Busca na lista (sem acento/maiusculas); categorias vazias somem. */
export function filterVocab(cats: VocabCategory[], query: string): VocabCategory[] {
  const q = fold(query.trim());
  if (!q) return cats;
  return cats.map((c) => ({ name: c.name, terms: c.terms.filter((t) => fold(t).includes(q)) })).filter((c) => c.terms.length > 0);
}
