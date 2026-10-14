// Tipos de terminal (WSL, PowerShell, cmd...) para filtro e agrupamento.
// O Go manda kind/kind_label/distro/agent em cada pane da lista
// (panekind.go). Funcoes puras testadas em tests/kinds.test.ts.

import type { PaneInfo } from "./types";

/** Grupos da barra lateral (pwsh entra em PowerShell; mobaxterm em Outros). */
export type KindGroup = "wsl" | "powershell" | "cmd" | "gitbash" | "ssh" | "serial" | "other" | "unknown";

/** Ordem padrao dos grupos (configuravel em Configuracoes -> Barra lateral). */
export const KIND_ORDER: KindGroup[] = ["wsl", "powershell", "cmd", "gitbash", "ssh", "serial", "other", "unknown"];

/** Move o item i para j (ordem dos grupos). */
export function moveItem<T>(list: T[], i: number, j: number): T[] {
  if (j < 0 || j >= list.length) return list;
  const out = list.slice();
  const [x] = out.splice(i, 1);
  out.splice(j, 0, x);
  return out;
}

/** Ordem escolhida pelo usuario + os grupos que faltarem, na ordem padrao. */
export function kindOrder(custom?: string[] | null): KindGroup[] {
  const valid = (custom ?? []).filter((k): k is KindGroup => (KIND_ORDER as string[]).includes(k));
  const seen = new Set(valid);
  return [...new Set([...valid, ...KIND_ORDER.filter((k) => !seen.has(k))])];
}

export const KIND_LABEL: Record<KindGroup, string> = {
  wsl: "WSL",
  powershell: "PowerShell",
  cmd: "cmd",
  gitbash: "Git Bash",
  ssh: "SSH",
  serial: "Serial",
  other: "Outros",
  unknown: "Desconhecido",
};

/** Filtro especial: so' terminais com agente (Claude Code etc.). */
export const AGENT_FILTER = "agent";

export function kindGroup(p: Pick<PaneInfo, "kind">): KindGroup {
  switch (p.kind) {
    case "wsl":
      return "wsl";
    case "powershell":
    case "pwsh":
      return "powershell";
    case "cmd":
      return "cmd";
    case "gitbash":
      return "gitbash";
    case "ssh":
      return "ssh";
    case "serial":
      return "serial";
    case "mobaxterm":
    case "other":
      return "other";
    case "unknown":
    case "":
    case undefined:
      return "unknown";
    default:
      // bash, zsh, fish, sh e qualquer kind ainda sem grupo (Linux/macOS).
      // Cai em Outros; KIND_ORDER salvo pelo usuario nao ganha entrada nova.
      // kind ausente, vazio ou "unknown" continua Desconhecido. kind_label nao entra aqui.
      return "other";
  }
}

/**
 * Filtro por tipo (multisselecao). Tipos marcados = OU entre si; "agent"
 * marcado = E (precisa ser agente). Nada marcado = todos.
 */
export function passesKindFilter(p: PaneInfo, selected: string[]): boolean {
  if (selected.length === 0) return true;
  const kinds = selected.filter((s) => s !== AGENT_FILTER);
  if (selected.includes(AGENT_FILTER) && !p.agent) return false;
  return kinds.length === 0 || kinds.includes(kindGroup(p));
}

export function countKinds(panes: PaneInfo[]): Record<KindGroup | "agent", number> {
  const c = { wsl: 0, powershell: 0, cmd: 0, gitbash: 0, ssh: 0, serial: 0, other: 0, unknown: 0, agent: 0 };
  for (const p of panes) {
    c[kindGroup(p)]++;
    if (p.agent) c.agent++;
  }
  return c;
}

export interface KindSection {
  key: string;
  group: KindGroup;
  label: string;
  panes: PaneInfo[];
  /** so' WSL: subgrupos por distro */
  distros?: { distro: string; panes: PaneInfo[] }[];
}

/** Agrupa por tipo (ordem fixa) e, dentro de WSL, por distro. */
export function groupByKind(panes: PaneInfo[], order?: string[] | null): KindSection[] {
  const out: KindSection[] = [];
  for (const g of kindOrder(order)) {
    const ps = panes.filter((p) => kindGroup(p) === g).sort((a, b) => a.pane_id - b.pane_id);
    if (ps.length === 0) continue;
    const sec: KindSection = { key: g, group: g, label: KIND_LABEL[g], panes: ps };
    if (g === "wsl") {
      const by = new Map<string, PaneInfo[]>();
      for (const p of ps) {
        const d = p.distro || "padrão";
        by.set(d, [...(by.get(d) ?? []), p]);
      }
      if (by.size > 1 || !by.has("padrão")) {
        sec.distros = [...by.entries()]
          .sort((a, b) => (a[0] === "padrão" ? -1 : b[0] === "padrão" ? 1 : a[0].localeCompare(b[0])))
          .map(([distro, panes]) => ({ distro, panes }));
      }
    }
    if (g === "ssh") {
      // SSH: um subgrupo por host remoto ("SSH · host")
      const by = new Map<string, PaneInfo[]>();
      for (const p of ps) {
        const h = p.ssh_host || "host desconhecido";
        by.set(h, [...(by.get(h) ?? []), p]);
      }
      sec.distros = [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([distro, panes]) => ({ distro, panes }));
    }
    out.push(sec);
  }
  return out;
}
