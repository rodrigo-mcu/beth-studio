// Busca de terminais: sem acento, sem diferenciar maiusculas (NFD),
// varios termos = E logico. Funcoes puras (testadas em tests/search.test.ts).

export interface SearchField {
  kind: "title" | "cwd" | "folder" | "webtab" | "host" | "id" | "content";
  label: string;
  text: string;
}

export interface SearchEntry {
  pane: number;
  gone: boolean;
  fields: SearchField[];
}

export interface FieldHit {
  field: SearchField;
  /** trechos [inicio, fim) no texto ORIGINAL do campo */
  ranges: [number, number][];
}

export interface SearchResult {
  entry: SearchEntry;
  hits: FieldHit[];
  score: number;
}

/** Texto normalizado + mapa indice-normalizado -> indice-original. */
export function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let i = 0;
  for (const ch of s) {
    const n = ch
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    for (let k = 0; k < n.length; k++) {
      norm += n[k];
      map.push(i);
    }
    i += ch.length;
  }
  map.push(i);
  return { norm, map };
}

export function normalize(s: string): string {
  return normalizeWithMap(s).norm;
}

export function terms(q: string): string[] {
  return normalize(q)
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

const WEIGHT: Record<SearchField["kind"], number> = {
  title: 10,
  folder: 8,
  webtab: 6,
  id: 6,
  cwd: 4,
  host: 3,
  content: 1,
};

/** Casa uma entrada: TODOS os termos precisam aparecer em algum campo. */
export function matchEntry(entry: SearchEntry, ts: string[]): SearchResult | null {
  if (ts.length === 0) return null;
  const norms = entry.fields.map((f) => normalizeWithMap(f.text));
  const hitsByField = new Map<number, [number, number][]>();
  let score = 0;
  for (const t of ts) {
    let found = false;
    let best = 0;
    norms.forEach((n, fi) => {
      let from = 0;
      for (;;) {
        const at = n.norm.indexOf(t, from);
        if (at < 0) break;
        found = true;
        const r: [number, number] = [n.map[at], n.map[at + t.length]];
        const list = hitsByField.get(fi) ?? [];
        list.push(r);
        hitsByField.set(fi, list);
        const w = WEIGHT[entry.fields[fi].kind] * (at === 0 || /[\s/\\:._-]/.test(n.norm[at - 1]) ? 2 : 1);
        if (w > best) best = w;
        from = at + Math.max(1, t.length);
        if (list.length > 50) break;
      }
    });
    if (!found) return null;
    score += best;
  }
  if (entry.gone) score -= 5;
  const hits: FieldHit[] = [...hitsByField.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([fi, ranges]) => ({ field: entry.fields[fi], ranges: mergeRanges(ranges) }));
  return { entry, hits, score };
}

export function mergeRanges(r: [number, number][]): [number, number][] {
  const s = r.slice().sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
    else out.push([x[0], x[1]]);
  }
  return out;
}

export function search(entries: SearchEntry[], q: string, limit = 100): SearchResult[] {
  const ts = terms(q);
  if (ts.length === 0) return [];
  const out: SearchResult[] = [];
  for (const e of entries) {
    const r = matchEntry(e, ts);
    if (r) out.push(r);
  }
  out.sort((a, b) => b.score - a.score || a.entry.pane - b.entry.pane);
  return out.slice(0, limit);
}

/**
 * Trecho de uma linha em volta do primeiro destaque (para conteudo da tela
 * e cwd longos). Devolve o texto e os destaques deslocados.
 */
export function snippet(text: string, ranges: [number, number][], radius = 40): { text: string; ranges: [number, number][] } {
  if (ranges.length === 0) return { text: text.slice(0, radius * 2), ranges: [] };
  const [a] = ranges[0];
  let start = text.lastIndexOf("\n", a - 1) + 1;
  let end = text.indexOf("\n", a);
  if (end < 0) end = text.length;
  // pouco contexto a' esquerda: em listas estreitas o trecho achado aparece
  const left = Math.max(8, Math.round(radius / 3));
  if (a - start > left) start = a - left;
  if (end - a > radius * 2) end = a + radius * 2;
  const pre = start > 0 && text[start - 1] !== "\n" ? "…" : "";
  const post = end < text.length && text[end] !== "\n" ? "…" : "";
  const shift = pre.length - start;
  const rs = ranges
    .filter(([x, y]) => x >= start && y <= end)
    .map(([x, y]) => [x + shift, y + shift] as [number, number]);
  return { text: pre + text.slice(start, end).replace(/\s+/g, (m) => (m.includes("\n") ? " " : m)) + post, ranges: rs };
}

/** Remove escapes (CSI, OSC, charset) do texto SGR de um screen. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;:?<=>!]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[()*+][0-9A-Za-z]/g, "")
    .replace(/\x1b[@-Z\\-_=>78]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "");
}

/** Ultima pasta de um caminho ("C:\\x\\app" -> "app"). */
export function lastFolder(path: string): string {
  const p = path.replace(/[\\/]+$/, "");
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}
