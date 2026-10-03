// Textos curtos da tela do celular. Puras (tests/phoneText.test.ts).

/** "agora", "há 4 min", "há 2 h". */
export function waitedFor(since: number, now: number): string {
  const min = Math.floor(Math.max(0, now - since) / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `há ${h} h` : `há ${Math.floor(h / 24)} d`;
}

/** Teclas rápidas: o que aparece e o que vai ao terminal. */
export const QUICK_KEYS: { label: string; aria: string; data: string }[] = [
  { label: "1", aria: "Tecla 1", data: "1" },
  { label: "2", aria: "Tecla 2", data: "2" },
  { label: "3", aria: "Tecla 3", data: "3" },
  { label: "↑", aria: "Seta para cima", data: "\x1b[A" },
  { label: "↓", aria: "Seta para baixo", data: "\x1b[B" },
  { label: "Enter", aria: "Enter", data: "\r" },
  { label: "Esc", aria: "Esc", data: "\x1b" },
];

// Símbolo de status que os agentes põem no começo do título (✳ ◐ ⠋ …).
const titleGlyph = /^[⠀-⣿◐-◓✢-✽⏺●○·*]+\s+/u;

/** Título sem o símbolo de status do agente. */
export function cleanTitle(t: string): string {
  const s = t.replace(titleGlyph, "").trim();
  return s || t.trim();
}

/** Tipo que vale a pena mostrar ("Desconhecido" não diz nada). */
export function kindText(kindLabel: string | undefined, agent: boolean | undefined): string {
  const k = (kindLabel ?? "").trim();
  if (!k || /^desconhecido$/i.test(k) || /^unknown$/i.test(k)) return agent ? "Agente" : "Terminal";
  return k;
}

export type ScreenLine = { rule: true } | { rule: false; text: string };

const ruleRe = /^[\s─━═╌╍┄┅┈┉\-_—]+$/u;

/** Linhas da tela; as réguas (───) viram um divisor em vez de quebrar em várias linhas. */
export function screenLines(text: string): ScreenLine[] {
  return text.split("\n").map((l) => (l.trim().length >= 6 && ruleRe.test(l) ? { rule: true } : { rule: false, text: l }));
}

// --- busca e filtro da lista -------------------------------------------

export interface PaneLike {
  pane_id: number;
  title: string;
  cwd: string;
  kind?: string;
  kind_label?: string;
  distro?: string;
  agent?: boolean;
  ssh_host?: string;
}

export type KindFilter = "all" | "agent" | "wsl" | "powershell" | "cmd" | "gitbash" | "ssh" | "other";

export const KIND_LABELS: Record<Exclude<KindFilter, "all">, string> = {
  agent: "Agentes",
  wsl: "WSL",
  powershell: "PowerShell",
  cmd: "cmd",
  gitbash: "Git Bash",
  ssh: "SSH",
  other: "Outros",
};

/** Grupo do filtro por tipo (pwsh e PowerShell 5.1 ficam juntos). */
export function kindGroup(p: PaneLike): Exclude<KindFilter, "all" | "agent"> {
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
  }
  return "other";
}

/** Tipos que existem na lista, na ordem dos botões. "Todos" sempre vem primeiro. */
export function kindChips(panes: PaneLike[]): KindFilter[] {
  const has = new Set<KindFilter>();
  for (const p of panes) {
    if (p.agent) has.add("agent");
    has.add(kindGroup(p));
  }
  const order: KindFilter[] = ["agent", "wsl", "powershell", "cmd", "gitbash", "ssh", "other"];
  return ["all", ...order.filter((k) => has.has(k))];
}

function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** Busca por nome, pasta, tipo, distro ou host; todas as palavras precisam aparecer. */
export function filterPanes<T extends PaneLike>(panes: T[], query: string, kind: KindFilter, label: (p: T) => string): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return panes.filter((p) => {
    if (kind === "agent" && !p.agent) return false;
    if (kind !== "all" && kind !== "agent" && kindGroup(p) !== kind) return false;
    if (!words.length) return true;
    const hay = fold([label(p), p.title, p.cwd, p.kind_label ?? "", p.distro ?? "", p.ssh_host ?? ""].join(" "));
    return words.every((w) => hay.includes(w));
  });
}

// --- ordem: o último aberto no celular vai para o topo -------------------

export type Recent = Record<number, number>;

/** Abertos por último primeiro; os nunca abertos seguem na ordem que vieram. */
export function byRecent<T extends { pane_id: number }>(panes: T[], recent: Recent): T[] {
  return panes
    .map((p, i) => ({ p, i, t: recent[p.pane_id] ?? 0 }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map((x) => x.p);
}

/** Marca como aberto agora e esquece terminais que não existem mais. */
export function touchRecent(recent: Recent, paneId: number, now: number, alive?: Set<number>): Recent {
  const next: Recent = {};
  for (const [k, v] of Object.entries(recent)) {
    const id = Number(k);
    if (!alive || alive.has(id)) next[id] = v;
  }
  next[paneId] = now;
  return next;
}
