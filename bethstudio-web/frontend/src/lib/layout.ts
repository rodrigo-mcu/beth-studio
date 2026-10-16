// Organizacao PROPRIA do web: abas do web, cada uma com uma arvore de
// splits (linhas/colunas). Nada disto muda janelas/abas/splits do host.
//
// Funcoes puras (sem React, sem DOM): testadas em tests/layout.test.ts.
// Uma folha aponta para um pane do host pelo id; `gone` = o pane sumiu do
// host (a folha fica como marcador esmaecido ate o usuario remover).
// Um mesmo pane vivo fica em no maximo uma folha de todo o layout.

export interface LeafNode {
  type: "leaf";
  pane: number;
  gone?: boolean;
  title?: string;
  cwd?: string;
  host_id?: string;
}

export interface SplitNode {
  type: "split";
  /** row = lado a lado (colunas), col = um embaixo do outro */
  dir: "row" | "col";
  sizes: number[];
  children: LayoutNode[];
}

export type LayoutNode = LeafNode | SplitNode;

export interface WebTab {
  id: string;
  name: string;
  root: LayoutNode | null;
  /** so' nas abas fechadas: quando foi fechada */
  closed_at?: string;
  /** so' nas abas fechadas: desde quando todos os terminais estao encerrados (Go) */
  gone_since?: string;
}

export interface Layout {
  tabs: WebTab[];
  active: string;
  /** 2 = WebTab.name e' so' o nome dado pelo usuario ("" = acompanha o terminal) */
  v?: number;
  /** abas fechadas ("grupos fechados"), a mais recente primeiro */
  closed?: WebTab[];
}

export const MAX_CLOSED = 20;

export type Zone = "left" | "right" | "top" | "bottom" | "center";

export type Path = number[];

export const MAX_LEAVES_PER_TAB = 12;

let seq = 0;
export function newTabId(): string {
  seq = (seq + 1) % 1e6;
  return `t${Date.now().toString(36)}${seq.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function emptyLayout(name = ""): Layout {
  const id = newTabId();
  return { tabs: [{ id, name, root: null }], active: id, v: 2 };
}

export function leaf(pane: number): LeafNode {
  return { type: "leaf", pane };
}

// --- consultas ---------------------------------------------------------

export function leaves(node: LayoutNode | null, path: Path = [], out: { leaf: LeafNode; path: Path }[] = []) {
  if (!node) return out;
  if (node.type === "leaf") out.push({ leaf: node, path });
  else node.children.forEach((c, i) => leaves(c, [...path, i], out));
  return out;
}

/** Onde esta' um pane vivo (nao `gone`) no layout. */
export function findPane(layout: Layout, pane: number): { tabId: string; path: Path } | null {
  for (const t of layout.tabs) {
    for (const l of leaves(t.root)) {
      if (!l.leaf.gone && l.leaf.pane === pane) return { tabId: t.id, path: l.path };
    }
  }
  return null;
}

export function livePanes(layout: Layout): Set<number> {
  const s = new Set<number>();
  for (const t of layout.tabs) for (const l of leaves(t.root)) if (!l.leaf.gone) s.add(l.leaf.pane);
  return s;
}

export function tabById(layout: Layout, id: string): WebTab | undefined {
  return layout.tabs.find((t) => t.id === id);
}

export function nodeAt(node: LayoutNode | null, path: Path): LayoutNode | null {
  let n = node;
  for (const i of path) {
    if (!n || n.type !== "split") return null;
    n = n.children[i] ?? null;
  }
  return n;
}

// --- arvore ------------------------------------------------------------

function normSizes(sizes: number[], n: number): number[] {
  let s = sizes.length === n ? sizes.map((x) => (Number.isFinite(x) && x > 0 ? x : 0)) : [];
  if (s.length !== n || s.some((x) => x <= 0)) s = Array(n).fill(1);
  const sum = s.reduce((a, b) => a + b, 0);
  return s.map((x) => x / sum);
}

/** Colapsa splits com 0/1 filho e junta split filho de mesma direcao. */
export function normalize(node: LayoutNode | null): LayoutNode | null {
  if (!node || node.type === "leaf") return node;
  const kids: LayoutNode[] = [];
  const sizes: number[] = [];
  const base = normSizes(node.sizes, node.children.length);
  node.children.forEach((c, i) => {
    const n = normalize(c);
    if (!n) return;
    if (n.type === "split" && n.dir === node.dir) {
      n.children.forEach((cc, j) => {
        kids.push(cc);
        sizes.push(base[i] * n.sizes[j]);
      });
    } else {
      kids.push(n);
      sizes.push(base[i]);
    }
  });
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0];
  return {
    type: "split",
    dir: node.dir,
    children: kids,
    sizes: normSizes(sizes, kids.length),
  };
}

/** Remove a folha em `path` (o espaco dela vai para os vizinhos). */
export function removeAt(node: LayoutNode | null, path: Path): LayoutNode | null {
  if (!node) return null;
  if (path.length === 0) return null;
  if (node.type !== "split") return node;
  const [i, ...rest] = path;
  const kids = node.children.slice();
  const sizes = node.sizes.slice();
  const sub = removeAt(kids[i], rest);
  if (sub) {
    kids[i] = sub;
  } else {
    kids.splice(i, 1);
    sizes.splice(i, 1);
  }
  return normalize({ ...node, children: kids, sizes });
}

function replaceAt(node: LayoutNode, path: Path, repl: LayoutNode): LayoutNode {
  if (path.length === 0) return repl;
  if (node.type !== "split") return node;
  const [i, ...rest] = path;
  const kids = node.children.slice();
  kids[i] = replaceAt(kids[i], rest, repl);
  return { ...node, children: kids };
}

/** Insere `newLeaf` ao lado da folha em `path` (zona de borda). */
export function insertAt(root: LayoutNode, path: Path, zone: Exclude<Zone, "center">, newLeaf: LayoutNode): LayoutNode {
  const dir: SplitNode["dir"] = zone === "left" || zone === "right" ? "row" : "col";
  const before = zone === "left" || zone === "top";
  const target = nodeAt(root, path);
  if (!target) return root;
  const parentPath = path.slice(0, -1);
  const parent = path.length ? nodeAt(root, parentPath) : null;
  if (parent && parent.type === "split" && parent.dir === dir) {
    const i = path[path.length - 1];
    const kids = parent.children.slice();
    const sizes = parent.sizes.slice();
    const half = sizes[i] / 2;
    sizes[i] = half;
    const at = before ? i : i + 1;
    kids.splice(at, 0, newLeaf);
    sizes.splice(at, 0, half);
    return normalize(replaceAt(root, parentPath, { ...parent, children: kids, sizes }))!;
  }
  const split: SplitNode = {
    type: "split",
    dir,
    sizes: [0.5, 0.5],
    children: before ? [newLeaf, target] : [target, newLeaf],
  };
  return normalize(replaceAt(root, path, split))!;
}

/** Acrescenta a' direita de tudo (usado ao mover para uma aba). */
export function append(root: LayoutNode | null, newLeaf: LayoutNode): LayoutNode {
  if (!root) return newLeaf;
  if (root.type === "split" && root.dir === "row") {
    const n = root.children.length;
    const sizes = root.sizes.map((s) => (s * n) / (n + 1));
    return normalize({
      ...root,
      children: [...root.children, newLeaf],
      sizes: [...sizes, 1 / (n + 1)],
    })!;
  }
  return {
    type: "split",
    dir: "row",
    sizes: [0.5, 0.5],
    children: [root, newLeaf],
  };
}

export function setSizesAt(root: LayoutNode, path: Path, sizes: number[]): LayoutNode {
  const n = nodeAt(root, path);
  if (!n || n.type !== "split") return root;
  return replaceAt(root, path, {
    ...n,
    sizes: normSizes(sizes, n.children.length),
  });
}

// --- operacoes no layout ------------------------------------------------

function mapTab(layout: Layout, id: string, f: (t: WebTab) => WebTab): Layout {
  return { ...layout, tabs: layout.tabs.map((t) => (t.id === id ? f(t) : t)) };
}

/** Tira um pane vivo de onde estiver (o split que esvazia colapsa). */
export function detachPane(layout: Layout, pane: number): Layout {
  const at = findPane(layout, pane);
  if (!at) return layout;
  return mapTab(layout, at.tabId, (t) => ({
    ...t,
    root: removeAt(t.root, at.path),
  }));
}

/** Como detachPane, mas a aba que ficar sem terminal nenhum e' fechada (terminal destacado em janela). */
export function detachPaneClosingEmpty(layout: Layout, pane: number): Layout {
  const at = findPane(layout, pane);
  if (!at) return layout;
  const next = detachPane(layout, pane);
  const tab = tabById(next, at.tabId);
  return tab && !tab.root ? closeTab(next, at.tabId) : next;
}

/** Remove a folha (viva ou encerrada) em `path` da aba. */
export function removeLeafAt(layout: Layout, tabId: string, path: Path): Layout {
  return mapTab(layout, tabId, (t) => ({ ...t, root: removeAt(t.root, path) }));
}

function leafFor(layout: Layout, pane: number): LeafNode {
  const at = findPane(layout, pane);
  if (at) {
    const n = nodeAt(tabById(layout, at.tabId)!.root, at.path);
    if (n && n.type === "leaf") return { ...n };
  }
  return leaf(pane);
}

export function countLeaves(root: LayoutNode | null) {
  return leaves(root).length;
}

/** Move (ou coloca) um pane numa aba, ao final. */
export function movePaneToTab(layout: Layout, pane: number, tabId: string): Layout {
  const lf = leafFor(layout, pane);
  const at = findPane(layout, pane);
  if (at && at.tabId === tabId) return layout;
  const tab = tabById(layout, tabId);
  if (!tab || countLeaves(tab.root) >= MAX_LEAVES_PER_TAB) return layout;
  const l = detachPane(layout, pane);
  return mapTab(l, tabId, (t) => ({ ...t, root: append(t.root, lf) }));
}

/** Os ids do `?open=` da URL. Sem o parâmetro (ou vazio) é lista vazia: `Number("")` vale 0 e puxava o terminal 0 em toda carga. */
export function parseOpenParam(q: string | null): number[] {
  return (q ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map(Number);
}

/**
 * `?open=` da URL (Studio aberto com --open): só traz para a aba ativa o
 * terminal que ainda NÃO está organizado. Quem já está numa aba fica onde
 * está; antes, cada carga da página arrancava o terminal da aba dele e o
 * encaixava ao lado do que estava em foco.
 */
export function applyOpenParam(layout: Layout, ids: number[], alive: Set<number>): Layout {
  let next = layout;
  for (const id of ids) if (alive.has(id) && !findPane(next, id)) next = movePaneToTab(next, id, next.active);
  return next;
}

/** Resumo curto para o registro de diagnóstico: "ORACULO[4] | beth studio[3,0] | Aba 3[21]". */
export function layoutSummary(layout: Layout): string {
  return layout.tabs
    .map((t, i) => {
      const panes = leaves(t.root)
        .filter((x) => !x.leaf.gone && x.leaf.pane >= 0)
        .map((x) => x.leaf.pane);
      return `${t.name.trim() || `Aba ${i + 1}`}[${panes.join(",")}]`;
    })
    .join(" | ");
}

/** Terminal que mudou de aba entre dois layouts (registro de diagnóstico). */
export interface PaneMove {
  pane: number;
  from: string;
  to: string;
  /** a aba de origem ficou sem nenhum terminal */
  fromEmpty: boolean;
}

/** Os terminais que estavam numa aba em `prev` e estão em outra em `next`. */
export function movedPanes(prev: Layout, next: Layout): PaneMove[] {
  const label = (l: Layout, id: string) => {
    const i = l.tabs.findIndex((t) => t.id === id);
    return i < 0 ? id : l.tabs[i].name.trim() || `Aba ${i + 1}`;
  };
  const out: PaneMove[] = [];
  for (const pane of livePanes(prev)) {
    const a = findPane(prev, pane);
    const b = findPane(next, pane);
    if (!a || !b || a.tabId === b.tabId) continue;
    const src = tabById(next, a.tabId);
    out.push({ pane, from: label(prev, a.tabId), to: label(next, b.tabId), fromEmpty: !src || countLeaves(src.root) === 0 });
  }
  return out;
}

/**
 * Solta `pane` sobre a folha viva `targetPane`: borda = dividir ali,
 * centro = trocar de lugar (se `pane` nao estava organizado, o alvo sai).
 */
export function dropOnPane(layout: Layout, pane: number, targetPane: number, zone: Zone): Layout {
  if (pane === targetPane) return layout;
  const target = findPane(layout, targetPane);
  if (!target) return layout;
  const from = findPane(layout, pane);
  const lf = leafFor(layout, pane);
  if (zone === "center") {
    const tl = leafFor(layout, targetPane);
    let l = mapTab(layout, target.tabId, (t) => ({
      ...t,
      root: replaceAt(t.root!, target.path, lf),
    }));
    if (from) {
      // o pane arrastado ja' estava numa folha: o alvo vai para la'
      l = mapTab(l, from.tabId, (t) => ({
        ...t,
        root: replaceAt(t.root!, from.path, tl),
      }));
    }
    return l;
  }
  if (!from || from.tabId !== target.tabId) {
    const tab = tabById(layout, target.tabId)!;
    if (countLeaves(tab.root) >= MAX_LEAVES_PER_TAB) return layout;
  }
  const l = detachPane(layout, pane);
  const t2 = findPane(l, targetPane)!; // o caminho pode ter mudado
  return mapTab(l, t2.tabId, (t) => ({
    ...t,
    root: insertAt(t.root!, t2.path, zone, lf),
  }));
}

/** Coloca `pane` numa aba vazia (ou ao final dela). */
export function dropOnEmptyTab(layout: Layout, pane: number, tabId: string): Layout {
  return movePaneToTab(layout, pane, tabId);
}

/** Troca o pane de uma folha viva por outro (clique na barra lateral). */
export function replacePane(layout: Layout, targetPane: number, pane: number): Layout {
  return dropOnPane(layout, pane, targetPane, "center");
}

export function addTab(layout: Layout, name: string, pane?: number): Layout {
  const id = newTabId();
  let l: Layout = {
    ...layout,
    tabs: [...layout.tabs, { id, name, root: null }],
    active: id,
  };
  if (pane !== undefined) l = movePaneToTab(l, pane, id);
  return l;
}

/** Nome dado pelo usuario; vazio = voltar a acompanhar o nome do terminal. */
export function renameTab(layout: Layout, id: string, name: string): Layout {
  const n = name.trim().slice(0, 60);
  return mapTab(layout, id, (t) => ({ ...t, name: n }));
}

/** Nomes que o web dava sozinho (antes da v2): nao sao do usuario. */
const AUTO_NAME =
  /^(Principal|Nova aba|Aba \d+|Prompt de comando|PowerShell( 5\.1| 7)?|WSL( \(padr[aã]o\)| Ubuntu| · .+)?|Git Bash|MobaXterm|cmd)$/;

export function isAutoTabName(name: string): boolean {
  return AUTO_NAME.test(name.trim());
}

/**
 * Nome exibido: o do usuario; senao o titulo do terminal em foco na aba
 * (ou do primeiro terminal vivo; ou do encerrado); senao "Aba N".
 */
export function tabDisplayName(tab: WebTab, index: number, titleOf: (pane: number) => string | undefined, focusedPane?: number | null): string {
  if (tab.name.trim()) return tab.name.trim();
  const ls = leaves(tab.root);
  const live = ls.filter((l) => !l.leaf.gone);
  const pick = (focusedPane != null && live.find((l) => l.leaf.pane === focusedPane)) || live.find((l) => titleOf(l.leaf.pane)) || live[0];
  const t = pick ? titleOf(pick.leaf.pane) : undefined;
  if (t && t.trim()) return t.trim();
  const g = ls.find((l) => l.leaf.gone && l.leaf.title);
  if (g?.leaf.title) return g.leaf.title;
  return `Aba ${index + 1}`;
}

/** Fecha a aba: os terminais dela ficam "nao organizados" (nada no host muda). */
export function closeTab(layout: Layout, id: string, now = new Date()): Layout {
  const i = layout.tabs.findIndex((t) => t.id === id);
  if (i < 0) return layout;
  const tab = layout.tabs[i];
  // Guarda a aba fechada (so' os terminais vivos; encerrados saem do split),
  // para o clique num terminal dela a reabrir inteira.
  let root = tab.root;
  for (;;) {
    const g = leaves(root).find((x) => x.leaf.gone || x.leaf.pane < 0);
    if (!g) break;
    root = removeAt(root, g.path);
  }
  const mine = new Set(leaves(root).map((x) => x.leaf.pane));
  let closed = (layout.closed ?? []).map((c) => ({ ...c, root: withoutPanes(c.root, mine) })).filter((c) => c.root);
  if (root) closed = [{ id: tab.id, name: tab.name, root, closed_at: now.toISOString() }, ...closed].slice(0, MAX_CLOSED);
  const tabs = layout.tabs.filter((t) => t.id !== id);
  const base: Layout = tabs.length === 0 ? emptyLayout() : { ...layout, tabs, active: layout.active === id ? tabs[Math.max(0, i - 1)].id : layout.active };
  return withClosed(base, closed);
}

function withClosed(l: Layout, closed: WebTab[]): Layout {
  const { closed: _drop, ...rest } = l;
  void _drop;
  return closed.length ? { ...rest, closed } : rest;
}

/** Tira da arvore as folhas vivas destes panes (o split colapsa). */
function withoutPanes(root: LayoutNode | null, panes: Set<number>): LayoutNode | null {
  let r = root;
  for (;;) {
    const x = leaves(r).find((y) => !y.leaf.gone && panes.has(y.leaf.pane));
    if (!x) return r;
    r = removeAt(r, x.path);
  }
}

/**
 * Terminal que foi para alguma aba sai dos grupos fechados (um pane vive
 * numa folha so'); grupo que esvazia some. Devolve o mesmo objeto se nada
 * mudou (a gravacao compara).
 */
export function pruneClosed(layout: Layout): Layout {
  if (!layout.closed?.length) return layout;
  const live = livePanes(layout);
  let changed = false;
  const closed: WebTab[] = [];
  for (const c of layout.closed) {
    const root = withoutPanes(c.root, live);
    if (root !== c.root) changed = true;
    if (root) closed.push(root === c.root ? c : { ...c, root });
  }
  return changed ? withClosed(layout, closed) : layout;
}

/** Indice do grupo fechado onde este pane (vivo) esta'; -1 = nenhum. */
export function closedGroupOf(layout: Layout, pane: number): number {
  return (layout.closed ?? []).findIndex((c) => leaves(c.root).some((x) => !x.leaf.gone && x.leaf.pane === pane));
}

/**
 * Reabre o grupo fechado `index` como aba nova e ativa, com o layout e o
 * nome. Ficam de fora: terminais encerrados e os que ja' estao em outra
 * aba (o split colapsa). O grupo sai da lista. `alive` (opcional) diz quais
 * panes existem agora no host.
 */
export function restoreClosed(layout: Layout, index: number, alive?: Set<number>): { layout: Layout; tabId: string | null } {
  const c = layout.closed?.[index];
  if (!c) return { layout, tabId: null };
  const rest = (layout.closed ?? []).filter((_, i) => i !== index);
  let root = c.root;
  for (;;) {
    const x = leaves(root).find((y) => y.leaf.gone || findPane(layout, y.leaf.pane) || (alive && !alive.has(y.leaf.pane)));
    if (!x) break;
    root = removeAt(root, x.path);
  }
  if (!root) return { layout: withClosed(layout, rest), tabId: null };
  const id = ids(layout).has(c.id) ? newTabId() : c.id;
  const l: Layout = { ...layout, tabs: [...layout.tabs, { id, name: c.name, root }], active: id };
  return { layout: withClosed(l, rest), tabId: id };
}

function ids(l: Layout): Set<string> {
  return new Set(l.tabs.map((t) => t.id));
}

/** Terminais "nao organizados" agrupados pelo grupo fechado de onde vieram. */
export function looseByClosedGroup(layout: Layout, loose: number[]): { group: WebTab | null; index: number; panes: number[] }[] {
  const out: { group: WebTab | null; index: number; panes: number[] }[] = [];
  const used = new Set<number>();
  const set = new Set(loose);
  (layout.closed ?? []).forEach((c, index) => {
    const ps = leaves(c.root)
      .filter((x) => !x.leaf.gone && set.has(x.leaf.pane) && !used.has(x.leaf.pane))
      .map((x) => x.leaf.pane);
    if (ps.length >= 2) {
      ps.forEach((p) => used.add(p));
      out.push({ group: c, index, panes: ps });
    }
  });
  const rest = loose.filter((p) => !used.has(p));
  if (rest.length) out.push({ group: null, index: -1, panes: rest });
  return out;
}

export function moveTab(layout: Layout, id: string, toIndex: number): Layout {
  const i = layout.tabs.findIndex((t) => t.id === id);
  if (i < 0) return layout;
  const tabs = layout.tabs.slice();
  const [t] = tabs.splice(i, 1);
  tabs.splice(Math.max(0, Math.min(tabs.length, toIndex)), 0, t);
  return { ...layout, tabs };
}

export function setActive(layout: Layout, id: string): Layout {
  return tabById(layout, id) ? { ...layout, active: id } : layout;
}

export function setSizes(layout: Layout, tabId: string, path: Path, sizes: number[]): Layout {
  return mapTab(layout, tabId, (t) => (t.root ? { ...t, root: setSizesAt(t.root, path, sizes) } : t));
}

/** Nomes padrao "Aba N" livres. */
export function nextTabName(layout: Layout): string {
  const used = new Set(layout.tabs.map((t) => t.name));
  for (let n = layout.tabs.length + 1; ; n++) if (!used.has(`Aba ${n}`)) return `Aba ${n}`;
}

/** Valida/limpa um layout vindo de fora (localStorage, servidor antigo). */
/** Terminal que o arquivo trazia em mais de uma aba: `kept` é onde ficou, `dropped` de onde saiu. */
export interface DuplicatePane {
  pane: number;
  kept: string;
  dropped: string[];
}

/**
 * Terminais vivos que aparecem em mais de uma aba. Fica a aba onde ele está
 * sozinho (a mais provável de ser a escolha do usuário; o ladear por engano
 * é o defeito mais comum); sem isso, a primeira. Duplicata dentro da mesma
 * aba não entra aqui: o sanitize já mantém a primeira folha.
 */
function findDuplicatePanes(tabs: unknown[]): Map<number, DuplicatePane> {
  const where = new Map<number, string[]>();
  const live = new Map<string, number>();
  const ids = new Set<string>();
  const walk = (n: unknown, tab: string, depth: number) => {
    if (!n || typeof n !== "object" || depth > 8) return;
    const x = n as { type?: string; pane?: number; gone?: boolean; children?: unknown[] };
    if (x.type === "leaf") {
      if (x.gone || !Number.isInteger(x.pane) || (x.pane as number) < 0) return;
      live.set(tab, (live.get(tab) ?? 0) + 1);
      const w = where.get(x.pane as number) ?? [];
      if (!w.includes(tab)) w.push(tab);
      where.set(x.pane as number, w);
    } else if (x.type === "split" && Array.isArray(x.children)) x.children.forEach((c) => walk(c, tab, depth + 1));
  };
  for (const t of tabs) {
    const tt = t as { id?: unknown; root?: unknown } | null;
    if (!tt || typeof tt.id !== "string" || !tt.id || ids.has(tt.id)) continue;
    ids.add(tt.id);
    walk(tt.root, tt.id, 0);
  }
  const out = new Map<number, DuplicatePane>();
  for (const [pane, w] of where) {
    if (w.length < 2) continue;
    const kept = w.find((id) => live.get(id) === 1) ?? w[0];
    out.set(pane, { pane, kept, dropped: w.filter((id) => id !== kept) });
  }
  return out;
}

export function sanitize(input: unknown, report?: DuplicatePane[]): Layout | null {
  if (!input || typeof input !== "object") return null;
  const l = input as Partial<Layout>;
  if (!Array.isArray(l.tabs)) return null;
  const seen = new Set<number>();
  const dups = findDuplicatePanes(l.tabs);
  let curTab = "";
  const node = (n: unknown, depth: number): LayoutNode | null => {
    if (!n || typeof n !== "object" || depth > 8) return null;
    const x = n as {
      type?: string;
      pane?: number;
      gone?: boolean;
      dir?: string;
      children?: unknown[];
      sizes?: unknown[];
    };
    if (x.type === "leaf") {
      if (!Number.isInteger(x.pane) || (x.pane as number) < 0) return null;
      if (!x.gone) {
        const d = dups.get(x.pane!);
        if (d && d.kept !== curTab) return null;
        if (seen.has(x.pane!)) return null;
        seen.add(x.pane!);
      }
      return { ...(x as unknown as LeafNode) };
    }
    if (x.type === "split" && (x.dir === "row" || x.dir === "col") && Array.isArray(x.children)) {
      const kids: LayoutNode[] = [];
      const sizes: number[] = [];
      x.children.forEach((c, i) => {
        const k = node(c, depth + 1);
        if (k) {
          kids.push(k);
          sizes.push(Array.isArray(x.sizes) ? Number(x.sizes[i]) : 1);
        }
      });
      return normalize({ type: "split", dir: x.dir, children: kids, sizes });
    }
    return null;
  };
  const ids = new Set<string>();
  const tabs: WebTab[] = [];
  for (const t of l.tabs) {
    if (!t || typeof t.id !== "string" || !t.id || ids.has(t.id)) continue;
    ids.add(t.id);
    curTab = t.id;
    tabs.push({
      id: t.id,
      name: typeof t.name === "string" ? t.name.trim().slice(0, 60) : "",
      root: node(t.root, 0),
    });
  }
  if (tabs.length === 0) return null;
  curTab = "";
  if (report) report.push(...dups.values());
  const active = tabs.some((t) => t.id === l.active) ? (l.active as string) : tabs[0].id;
  // Migracao para v2: nomes automaticos antigos viram "acompanha o terminal".
  if ((l as Layout).v !== 2) for (const t of tabs) if (isAutoTabName(t.name)) t.name = "";
  // abas fechadas: validadas a' parte (os panes delas nao estao em abas)
  const closed: WebTab[] = [];
  seen.clear();
  for (const t of Array.isArray(l.closed) ? l.closed : []) {
    if (closed.length >= MAX_CLOSED) break;
    if (!t || typeof t.id !== "string" || !t.id || ids.has(t.id)) continue;
    const root = node(t.root, 0);
    if (!root) continue;
    ids.add(t.id);
    closed.push({
      id: t.id,
      name: typeof t.name === "string" ? t.name.trim().slice(0, 60) : "",
      root,
      ...(typeof t.closed_at === "string" ? { closed_at: t.closed_at } : {}),
      ...(typeof t.gone_since === "string" ? { gone_since: t.gone_since } : {}),
    });
  }
  return closed.length ? { tabs, active, v: 2, closed } : { tabs, active, v: 2 };
}

/**
 * Clique num terminal (barra lateral, busca, agentes aguardando):
 *  - ja' esta' numa aba do web -> ativa essa aba;
 *  - nao esta' organizado -> cria uma aba NOVA so' com ele (sem nome: a aba
 *    acompanha o titulo do terminal) e ativa. Nunca substitui o terminal em
 *    foco ("Abrir ao lado" continua sendo a acao explicita).
 * Uma aba vazia ativa e' reaproveitada em vez de criar outra.
 */
export function openPaneInTab(layout: Layout, pane: number, storedName = "", alive?: Set<number>): { layout: Layout; tabId: string } {
  const at = findPane(layout, pane);
  if (at) return { layout: setActive(layout, at.tabId), tabId: at.tabId };
  // Estava numa aba fechada: reabre a aba inteira (com os outros terminais dela)
  const g = closedGroupOf(layout, pane);
  if (g >= 0) {
    const r = restoreClosed(layout, g, alive);
    if (r.tabId && findPane(r.layout, pane)) return { layout: r.layout, tabId: r.tabId };
  }
  const active = tabById(layout, layout.active);
  if (active && !active.root) {
    let l = movePaneToTab(layout, pane, active.id);
    // aba vazia sem nome: ganha o nome que o usuario tinha dado a este terminal
    if (!active.name && storedName) l = renameTab(l, active.id, storedName);
    return { layout: l, tabId: active.id };
  }
  const l = addTab(layout, storedName, pane);
  return { layout: l, tabId: l.active };
}

/** Panes vivos de uma aba (para guardar o nome dado a ela em cada um). */
export function tabPanes(tab: WebTab | undefined): number[] {
  return tab ? leaves(tab.root).filter((x) => !x.leaf.gone && x.leaf.pane >= 0).map((x) => x.leaf.pane) : [];
}

// --- "Novo terminal à direita/abaixo/…" ----------------------------------
// Enquanto o host cria o terminal, a folha nova e' um marcador provisorio
// ("abrindo…") com pane NEGATIVO. Ele nunca e' gravado (stripPlaceholders
// antes de salvar; sanitize e o Go descartam pane < 0).

export function isPlaceholder(pane: number): boolean {
  return pane < 0;
}

/** Poe o marcador `tempId` (< 0) ao lado de `targetPane`, dividindo 50/50. null = nao da'. */
export function insertPlaceholder(layout: Layout, targetPane: number, zone: Exclude<Zone, "center">, tempId: number, title = ""): Layout | null {
  if (tempId >= 0) return null;
  const at = findPane(layout, targetPane);
  if (!at) return null;
  const tab = tabById(layout, at.tabId)!;
  if (countLeaves(tab.root) >= MAX_LEAVES_PER_TAB) return null;
  const ph: LeafNode = {
    type: "leaf",
    pane: tempId,
    ...(title ? { title } : {}),
  };
  return mapTab(layout, at.tabId, (t) => ({
    ...t,
    root: insertAt(t.root!, at.path, zone, ph),
  }));
}

/**
 * O terminal nasceu: o marcador vira o pane real (mesmo lugar e tamanho).
 * Se o marcador sumiu (a organizacao foi trocada no meio), poe o pane ao
 * lado do alvo; se nem o alvo esta' mais la', devolve sem mudar.
 */
export function resolvePlaceholder(layout: Layout, tempId: number, pane: number, targetPane?: number, zone?: Exclude<Zone, "center">): Layout {
  const ph = findPane(layout, tempId);
  if (findPane(layout, pane)) return ph ? removeLeafAt(layout, ph.tabId, ph.path) : layout;
  if (ph)
    return mapTab(layout, ph.tabId, (t) => ({
      ...t,
      root: replaceAt(t.root!, ph.path, leaf(pane)),
    }));
  if (targetPane !== undefined && zone && findPane(layout, targetPane)) return dropOnPane(layout, pane, targetPane, zone);
  return layout;
}

/** Tira o marcador (erro ou tempo esgotado). */
export function removePlaceholder(layout: Layout, tempId: number): Layout {
  const ph = findPane(layout, tempId);
  return ph ? removeLeafAt(layout, ph.tabId, ph.path) : layout;
}

/** Copia sem marcadores (o que vai para o disco). */
export function stripPlaceholders(layout: Layout): Layout {
  let l = layout;
  for (;;) {
    const t = l.tabs.find((tt) => leaves(tt.root).some((x) => isPlaceholder(x.leaf.pane)));
    if (!t) return l;
    const x = leaves(t.root).find((y) => isPlaceholder(y.leaf.pane))!;
    l = removeLeafAt(l, t.id, x.path);
  }
}
