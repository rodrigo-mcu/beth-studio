// Barra lateral: o nome da pasta de cada terminal em destaque (cartão) e o
// modo "Por pasta" (terminais agrupados pela pasta atual). Testado em
// tests/folders.test.ts.
import { cwdPath, shortCwd } from "./panes.ts";
import type { PaneInfo } from "./types.ts";

/** Cartão: "…/work/repo/" (apagado) + "api-server" (em destaque). */
export function splitCwd(cwd: string, maxSegments = 4): { parent: string; name: string } {
  const s = shortCwd(cwd, maxSegments);
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (i < 0 || i === s.length - 1) return { parent: "", name: s };
  return { parent: s.slice(0, i + 1), name: s.slice(i + 1) };
}

export interface FolderGroup {
  /** caminho normalizado (chave estável para recolher o grupo) */
  key: string;
  /** nome da pasta; com o pai quando outro grupo tem o mesmo nome */
  label: string;
  /** caminho inteiro legível (dica do cabeçalho) */
  path: string;
  panes: PaneInfo[];
}

const NO_FOLDER = "Sem pasta";

/**
 * Agrupa pela pasta atual (o grupo muda quando o terminal faz cd). Ordem
 * alfabética pelo rótulo; terminais sem pasta conhecida ficam no fim.
 */
export function groupByFolder(panes: PaneInfo[]): FolderGroup[] {
  const map = new Map<string, { path: string; segs: string[]; panes: PaneInfo[] }>();
  const none: PaneInfo[] = [];
  for (const p of panes) {
    if (!p.cwd) {
      none.push(p);
      continue;
    }
    const { path, sep } = cwdPath(p.cwd);
    const key = sep === "\\" ? path.toLowerCase() : path; // Windows não diferencia maiúsculas
    let g = map.get(key);
    if (!g) {
      g = { path, segs: path.split(sep).filter(Boolean), panes: [] };
      map.set(key, g);
    }
    g.panes.push(p);
  }
  const entries = [...map.entries()];
  // rótulo: o nome da pasta; se repetir, vai ganhando os pais até ficar único
  const labelOf = (segs: string[], depth: number) => segs.slice(-depth).join("/") || "/";
  const depth = new Map(entries.map(([k]) => [k, 1]));
  for (let round = 0; round < 8; round++) {
    const byLabel = new Map<string, string[]>();
    for (const [k, g] of entries) {
      const l = labelOf(g.segs, depth.get(k)!).toLowerCase();
      byLabel.set(l, [...(byLabel.get(l) ?? []), k]);
    }
    let changed = false;
    for (const keys of byLabel.values()) {
      if (keys.length < 2) continue;
      for (const k of keys) {
        const g = map.get(k)!;
        if (depth.get(k)! < g.segs.length) {
          depth.set(k, depth.get(k)! + 1);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  const out: FolderGroup[] = entries.map(([k, g]) => ({ key: k, label: labelOf(g.segs, depth.get(k)!), path: g.path, panes: g.panes }));
  out.sort((a, b) => a.label.localeCompare(b.label, "pt-BR", { sensitivity: "base" }));
  if (none.length) out.push({ key: "", label: NO_FOLDER, path: "", panes: none });
  return out;
}
