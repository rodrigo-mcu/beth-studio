// Testes do modelo de layout do web. Rodar: node --test tests/
// (Node >= 23 executa TypeScript "apagavel" direto.)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detachPaneClosingEmpty,
  openPaneInTab,
  isAutoTabName,
  tabDisplayName,
  addTab,
  closeTab,
  dropOnPane,
  emptyLayout,
  findPane,
  leaves,
  livePanes,
  moveTab,
  movePaneToTab,
  removeLeafAt,
  renameTab,
  replacePane,
  applyOpenParam,
  parseOpenParam,
  movedPanes,
  layoutSummary,
  sanitize,
  setActive,
  setSizes,
  type DuplicatePane,
  type Layout,
  type LayoutNode,
} from "../src/lib/layout.ts";

/** Representacao curta da arvore: row(1,col(2,3)) */
function show(n: LayoutNode | null): string {
  if (!n) return "-";
  if (n.type === "leaf") return n.gone ? `x${n.pane}` : String(n.pane);
  return `${n.dir}(${n.children.map(show).join(",")})`;
}
const tab = (l: Layout, i = 0) => l.tabs[i];
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

function base(): Layout {
  let l = emptyLayout("A");
  const a = l.tabs[0].id;
  l = movePaneToTab(l, 1, a);
  l = movePaneToTab(l, 2, a);
  return l; // A: row(1,2)
}

test("mover para aba acrescenta a' direita", () => {
  const l = base();
  assert.equal(show(tab(l).root), "row(1,2)");
  assert.deepEqual(livePanes(l), new Set([1, 2]));
});

test("soltar na borda divide (mesma direcao entra no split do pai)", () => {
  let l = base();
  l = dropOnPane(l, 3, 2, "bottom");
  assert.equal(show(tab(l).root), "row(1,col(2,3))");
  l = dropOnPane(l, 4, 1, "left");
  assert.equal(show(tab(l).root), "row(4,1,col(2,3))");
  const root = tab(l).root as Extract<LayoutNode, { type: "split" }>;
  assert.ok(Math.abs(sum(root.sizes) - 1) < 1e-9);
  // 4 e 1 dividem a metade que era do 1
  assert.ok(Math.abs(root.sizes[0] - root.sizes[1]) < 1e-9);
});

test("mover um pane que esta' num split: o split que sobra colapsa", () => {
  let l = base();
  l = dropOnPane(l, 3, 2, "bottom"); // row(1,col(2,3))
  l = addTab(l, "B");
  const b = l.tabs[1].id;
  l = movePaneToTab(l, 3, b);
  assert.equal(show(tab(l, 0).root), "row(1,2)");
  assert.equal(show(tab(l, 1).root), "3");
  assert.deepEqual(findPane(l, 3), { tabId: b, path: [] });
});

test("um pane fica em no maximo uma aba", () => {
  let l = base();
  l = addTab(l, "B");
  const b = l.tabs[1].id;
  l = movePaneToTab(l, 1, b);
  l = movePaneToTab(l, 1, b); // de novo: nada muda
  const all = l.tabs.flatMap((t) => leaves(t.root).map((x) => x.leaf.pane));
  assert.deepEqual(all.sort(), [1, 2]);
  assert.equal(show(tab(l, 0).root), "2");
  assert.equal(show(tab(l, 1).root), "1");
});

test("centro troca de lugar; pane nao organizado substitui o alvo", () => {
  let l = base();
  l = dropOnPane(l, 3, 2, "bottom"); // row(1,col(2,3))
  l = dropOnPane(l, 1, 3, "center");
  assert.equal(show(tab(l).root), "row(3,col(2,1))");
  l = replacePane(l, 2, 9); // 9 nao estava organizado: 2 sai
  assert.equal(show(tab(l).root), "row(3,col(9,1))");
  assert.equal(findPane(l, 2), null);
});

test("mover dentro da mesma aba reposiciona", () => {
  let l = base(); // row(1,2)
  l = dropOnPane(l, 1, 2, "bottom");
  assert.equal(show(tab(l).root), "col(2,1)");
});

test("remover folha e fechar aba", () => {
  let l = base();
  l = removeLeafAt(l, tab(l).id, [0]);
  assert.equal(show(tab(l).root), "2");
  l = removeLeafAt(l, tab(l).id, []);
  assert.equal(show(tab(l).root), "-");
  l = addTab(l, "B", 5);
  assert.equal(l.active, l.tabs[1].id);
  l = closeTab(l, l.tabs[1].id);
  assert.equal(l.tabs.length, 1);
  assert.equal(l.active, l.tabs[0].id);
  assert.equal(findPane(l, 5), null); // ficou "nao organizado"
  l = closeTab(l, l.tabs[0].id); // nunca fica sem aba
  assert.equal(l.tabs.length, 1);
});

test("renomear e reordenar abas", () => {
  let l = addTab(addTab(emptyLayout("A"), "B"), "C");
  l = renameTab(l, l.tabs[1].id, "  Servidores  ");
  assert.equal(l.tabs[1].name, "Servidores");
  assert.equal(renameTab(l, l.tabs[1].id, "   ").tabs[1].name, ""); // vazio = acompanha o terminal
  l = moveTab(l, l.tabs[2].id, 0);
  assert.deepEqual(l.tabs.map((t) => t.name), ["C", "A", "Servidores"]);
});

test("tamanhos das divisorias sao normalizados", () => {
  let l = base();
  l = setSizes(l, tab(l).id, [], [3, 1]);
  const root = tab(l).root as Extract<LayoutNode, { type: "split" }>;
  assert.deepEqual(root.sizes, [0.75, 0.25]);
});

test("persistencia: JSON ida e volta + sanitize remove duplicados e lixo", () => {
  let l = base();
  l = dropOnPane(l, 3, 2, "bottom");
  const back = sanitize(JSON.parse(JSON.stringify(l)));
  assert.deepEqual(back, { ...l, v: 2 });
  const dirty = {
    active: "nao-existe",
    tabs: [
      { id: "a", name: "", root: { type: "split", dir: "row", sizes: [1, 1, 1], children: [{ type: "leaf", pane: 1 }, { type: "leaf", pane: 1 }, { type: "leaf", pane: -3 }] } },
      { id: "a", name: "dup", root: null },
      { id: "b", name: "B", root: { type: "leaf", pane: 7, gone: true, title: "velho" } },
    ],
  };
  const s = sanitize(dirty)!;
  assert.equal(s.tabs.length, 2);
  assert.equal(s.active, "a");
  assert.equal(s.tabs[0].name, "");
  assert.equal(show(s.tabs[0].root), "1");
  assert.equal(show(s.tabs[1].root), "x7");
  assert.equal(sanitize({ tabs: "x" }), null);
});

test("folha encerrada (gone) nao conta como pane vivo", () => {
  const l = sanitize({ active: "a", tabs: [{ id: "a", name: "A", root: { type: "leaf", pane: 4, gone: true } }] })!;
  assert.equal(findPane(l, 4), null);
  const l2 = movePaneToTab(l, 4, "a"); // o novo pane 4 (outro host) entra ao lado
  assert.equal(show(l2.tabs[0].root), "row(x4,4)");
});

test("nome da aba: do usuario prevalece; sem nome acompanha o terminal", () => {
  let l = base(); // A: row(1,2), nome "A" do usuario
  const titles: Record<number, string> = { 1: "✳ API VMS", 2: "Windows PowerShell" };
  const t = (p: number) => titles[p];
  assert.equal(tabDisplayName(l.tabs[0], 0, t, 2), "A");
  l = renameTab(l, l.tabs[0].id, "");
  assert.equal(tabDisplayName(l.tabs[0], 0, t, 2), "Windows PowerShell"); // o em foco
  assert.equal(tabDisplayName(l.tabs[0], 0, t, null), "✳ API VMS"); // sem foco: o primeiro
  titles[1] = "⏺ API VMS"; // titulo muda ao vivo
  assert.equal(tabDisplayName(l.tabs[0], 0, t, null), "⏺ API VMS");
  assert.equal(tabDisplayName({ id: "x", name: "", root: null }, 3, t), "Aba 4");
});

test("migracao: nomes automaticos antigos viram 'acompanha o terminal'", () => {
  const old = {
    active: "a",
    tabs: [
      { id: "a", name: "Principal", root: null },
      { id: "b", name: "WSL Ubuntu", root: null },
      { id: "c", name: "Aba 3", root: null },
      { id: "d", name: "Servidores", root: null },
    ],
  };
  const m = sanitize(old)!;
  assert.deepEqual(m.tabs.map((x) => x.name), ["", "", "", "Servidores"]);
  assert.equal(m.v, 2);
  // ja' migrado (v2): "Principal" escolhido pelo usuario depois fica
  const again = sanitize({ ...m, tabs: [{ id: "a", name: "Principal", root: null }] })!;
  assert.equal(again.tabs[0].name, "Principal");
  assert.ok(isAutoTabName("PowerShell 5.1") && !isAutoTabName("Meu PowerShell"));
});

test("clique num terminal: ativa a aba dele ou abre numa aba NOVA (nunca substitui)", () => {
  let l = base(); // aba A: row(1,2), ativa
  const a = l.tabs[0].id;
  // 9 nao organizado -> aba nova so' com ele, ativa; a aba A fica intacta
  let r = openPaneInTab(l, 9);
  assert.equal(r.layout.tabs.length, 2);
  assert.equal(r.layout.active, r.tabId);
  assert.equal(show(tab(r.layout, 0).root), "row(1,2)");
  assert.equal(show(tab(r.layout, 1).root), "9");
  assert.equal(tab(r.layout, 1).name, ""); // acompanha o titulo do terminal
  // clicar de novo no 9 reusa a aba dele
  l = r.layout;
  r = openPaneInTab(setActive(l, a), 9);
  assert.equal(r.layout.tabs.length, 2);
  assert.equal(r.tabId, l.tabs[1].id);
  // clicar no 2 (ja' na aba A) so' ativa A
  r = openPaneInTab(l, 2);
  assert.equal(r.layout.active, a);
  assert.equal(r.layout.tabs.length, 2);
  // aba vazia ativa e' reaproveitada
  const e = addTab(l, "");
  r = openPaneInTab(e, 7);
  assert.equal(r.layout.tabs.length, 3);
  assert.equal(show(tab(r.layout, 2).root), "7");
});

test("reabrir terminal: a aba nova nasce com o nome guardado do pane", async () => {
  const { openPaneInTab, tabPanes, renameTab, closeTab } = await import("../src/lib/layout.ts");
  let l = emptyLayout();
  l = movePaneToTab(l, 3, l.active);
  l = movePaneToTab(l, 4, l.active);
  const tab = l.tabs[0];
  assert.deepEqual(tabPanes(tab).sort(), [3, 4]); // o nome vai para os dois
  l = renameTab(l, tab.id, "Projeto X");
  l = addTab(l, "outra", 9);
  l = closeTab(l, tab.id);
  assert.equal(l.v, 2); // fechar aba nao pode perder a versao do layout
  // clique no terminal 4: aba nova com o nome guardado
  const r = openPaneInTab(l, 4, "Projeto X");
  const t = r.layout.tabs.find((x) => x.id === r.tabId)!;
  assert.equal(t.name, "Projeto X");
  // sem nome guardado: aba acompanha o terminal (nome vazio)
  const r2 = openPaneInTab(l, 5);
  assert.equal(r2.layout.tabs.find((x) => x.id === r2.tabId)!.name, "");
  // aba vazia ativa sem nome e' reaproveitada e ganha o nome
  let e = emptyLayout();
  const r3 = openPaneInTab(e, 4, "Projeto X");
  assert.equal(r3.layout.tabs.length, 1);
  assert.equal(r3.layout.tabs[0].name, "Projeto X");
  // aba vazia com nome proprio mantem o nome dela
  const named = { ...emptyLayout("Minha") };
  const r4 = openPaneInTab(named, 4, "Projeto X");
  assert.equal(r4.layout.tabs[0].name, "Minha");
  // ja' organizado: so' ativa a aba dele (nome nao muda)
  const r5 = openPaneInTab(r.layout, 4, "Outro");
  assert.equal(r5.tabId, r.tabId);
  assert.equal(r5.layout.tabs.find((x) => x.id === r5.tabId)!.name, "Projeto X");
  assert.deepEqual(tabPanes(undefined), []);
});

test("grupos fechados: fechar guarda, clicar num terminal reabre a aba inteira", async () => {
  const { closedGroupOf, restoreClosed, pruneClosed, looseByClosedGroup, closeTab, renameTab, openPaneInTab, setSizes } = await import(
    "../src/lib/layout.ts"
  );
  let l = emptyLayout();
  l = movePaneToTab(l, 1, l.active);
  l = dropOnPane(l, 2, 1, "bottom"); // col(1,2)
  l = setSizes(l, l.active, [], [0.7, 0.3]);
  l = renameTab(l, l.active, "Dupla");
  const id = l.active;
  l = addTab(l, "b", 7);
  l = closeTab(l, id, new Date("2026-09-25T16:00:00Z"));
  assert.equal(l.closed?.length, 1);
  assert.equal(l.closed![0].name, "Dupla");
  assert.equal(l.closed![0].closed_at, "2026-09-25T16:00:00.000Z");
  assert.equal(closedGroupOf(l, 2), 0);
  assert.equal(closedGroupOf(l, 7), -1);
  // sobrevive a' gravacao (sanitize) com os tamanhos
  const saved = sanitize(JSON.parse(JSON.stringify(l)))!;
  assert.equal(show(saved.closed![0].root), "col(1,2)");
  // clicar no terminal 2: a aba volta inteira, com o nome e os tamanhos, e sai da lista
  const r = openPaneInTab(saved, 2, "", new Set([1, 2, 7]));
  const t = r.layout.tabs.find((x) => x.id === r.tabId)!;
  assert.equal(t.name, "Dupla");
  assert.equal(show(t.root), "col(1,2)");
  assert.deepEqual((t.root as { sizes: number[] }).sizes, [0.7, 0.3]);
  assert.equal(r.layout.closed, undefined);
  // o 1 foi encerrado: volta so' o 2 (split colapsa)
  const r2 = openPaneInTab(saved, 2, "", new Set([2, 7]));
  assert.equal(show(r2.layout.tabs.find((x) => x.id === r2.tabId)!.root), "2");
  // o 1 ja' esta' em outra aba: fica la'
  const moved = movePaneToTab(saved, 1, saved.tabs[0].id);
  const pr = pruneClosed(moved);
  assert.equal(show(pr.closed![0].root), "2"); // tirar o pane da aba o tira do grupo
  const r3 = restoreClosed(pr, 0, new Set([1, 2, 7]));
  assert.equal(show(r3.layout.tabs.find((x) => x.id === r3.tabId)!.root), "2");
  // nada vivo: nao cria aba, grupo sai
  const r4 = restoreClosed(saved, 0, new Set([7]));
  assert.equal(r4.tabId, null);
  assert.equal(r4.layout.closed, undefined);
  // pruneClosed devolve o mesmo objeto quando nada muda (nao regrava a toa)
  assert.equal(pruneClosed(saved), saved);
  // barra lateral: os dois soltos aparecem juntos, com o grupo
  const g = looseByClosedGroup(saved, [1, 2, 5]);
  assert.equal(g.length, 2);
  assert.equal(g[0].group?.name, "Dupla");
  assert.deepEqual(g[0].panes, [1, 2]);
  assert.deepEqual(g[1].panes, [5]);
  // grupo com um so' terminal solto nao vira cabecalho
  assert.deepEqual(looseByClosedGroup(saved, [2, 5]), [{ group: null, index: -1, panes: [2, 5] }]);
});

test("grupos fechados: o mais recente primeiro, sem repetir terminal, fechar a última aba mantém a lista", async () => {
  const { closeTab } = await import("../src/lib/layout.ts");
  let l = emptyLayout();
  l = movePaneToTab(l, 1, l.active);
  l = dropOnPane(l, 2, 1, "right");
  const a = l.active;
  l = addTab(l, "B", 3);
  l = closeTab(l, a); // closed: [row(1,2)]
  l = movePaneToTab(l, 1, l.active); // 1 volta para a aba B...
  l = closeTab(l, l.active); // ...e B (3,1) fecha: 1 sai do grupo antigo
  assert.equal(l.tabs.length, 1); // a ultima aba vira uma aba vazia
  assert.equal(l.closed!.length, 2);
  assert.equal(l.closed![0].name, "B");
  assert.equal(show(l.closed![1].root), "2");
  // aba so' com terminais encerrados nao e' guardada
  let g = emptyLayout();
  g = { ...g, tabs: [{ ...g.tabs[0], root: { type: "leaf", pane: 9, gone: true } }] };
  g = addTab(g, "x");
  assert.equal(closeTab(g, g.tabs[0].id).closed, undefined);
});

test("destacar o único terminal da aba fecha a aba; com mais terminais só tira o pane", () => {
  let l = emptyLayout("A");
  l = addTab(l, "B", 2);
  l = movePaneToTab(l, 1, l.tabs[0].id);
  // aba A tem o 1, aba B tem o 2
  const out = detachPaneClosingEmpty(l, 1);
  assert.equal(out.tabs.length, 1);
  assert.equal(findPane(out, 1), null);
  assert.notEqual(findPane(out, 2), null);
  // aba com dois terminais: a aba fica
  const two = dropOnPane(l, 3, 2, "right");
  const kept = detachPaneClosingEmpty(two, 3);
  assert.equal(kept.tabs.length, 2);
  assert.notEqual(findPane(kept, 2), null);
  // pane fora do layout: nada muda
  assert.equal(detachPaneClosingEmpty(l, 99), l);
});

test("destacar o único terminal da única aba deixa uma aba vazia", () => {
  let l = emptyLayout("A");
  l = movePaneToTab(l, 1, l.tabs[0].id);
  const out = detachPaneClosingEmpty(l, 1);
  assert.equal(out.tabs.length, 1);
  assert.equal(out.tabs[0].root, null);
});

test("sanitize: terminal em duas abas fica na aba onde está sozinho e é relatado", () => {
  const raw = {
    active: "m",
    tabs: [
      { id: "m", name: "MANUAIS", root: { type: "split", dir: "row", sizes: [1, 1], children: [{ type: "leaf", pane: 9 }, { type: "leaf", pane: 0 }] } },
      { id: "x", name: "", root: { type: "leaf", pane: 0 } },
    ],
  };
  const rep: DuplicatePane[] = [];
  const s = sanitize(raw, rep)!;
  assert.equal(show(s.tabs[0].root), "9");
  assert.equal(show(s.tabs[1].root), "0");
  assert.deepEqual(rep, [{ pane: 0, kept: "x", dropped: ["m"] }]);
  // nenhuma aba só com ele: fica a primeira
  const raw2 = {
    active: "a",
    tabs: [
      { id: "a", name: "", root: { type: "split", dir: "row", sizes: [1, 1], children: [{ type: "leaf", pane: 1 }, { type: "leaf", pane: 2 }] } },
      { id: "b", name: "", root: { type: "split", dir: "row", sizes: [1, 1], children: [{ type: "leaf", pane: 2 }, { type: "leaf", pane: 3 }] } },
    ],
  };
  const rep2: DuplicatePane[] = [];
  const s2 = sanitize(raw2, rep2)!;
  assert.equal(show(s2.tabs[0].root), "row(1,2)");
  assert.equal(show(s2.tabs[1].root), "3");
  assert.deepEqual(rep2, [{ pane: 2, kept: "a", dropped: ["b"] }]);
  // sem duplicata, sem relatório
  const rep3: DuplicatePane[] = [];
  sanitize({ active: "a", tabs: [{ id: "a", name: "", root: { type: "leaf", pane: 5 } }] }, rep3);
  assert.deepEqual(rep3, []);
});

test("open= não tira de outra aba o terminal que já está organizado", () => {
  // aba "support agent" com o 0 e aba ativa "beth studio" com o 3
  let l = emptyLayout("support agent");
  l = movePaneToTab(l, 0, l.tabs[0].id);
  l = addTab(l, "beth studio", 3);
  const next = applyOpenParam(l, [0, 3], new Set([0, 3]));
  assert.equal(next, l);
  assert.equal(show(tab(next, 0).root), "0");
  assert.equal(show(tab(next, 1).root), "3");
});

test("open= traz só o terminal que ainda não está em nenhuma aba, e só os vivos", () => {
  let l = emptyLayout("A");
  l = movePaneToTab(l, 1, l.tabs[0].id);
  const next = applyOpenParam(l, [1, 2, 9], new Set([1, 2]));
  assert.equal(show(tab(next).root), "row(1,2)");
  assert.equal(findPane(next, 9), null);
});

test("movedPanes: lista o terminal arrancado da aba e avisa que a origem ficou vazia", () => {
  let before = emptyLayout("support agent");
  before = movePaneToTab(before, 0, before.tabs[0].id);
  before = addTab(before, "beth studio", 3);
  const after = movePaneToTab(before, 0, before.active); // o que o open= fazia
  assert.deepEqual(movedPanes(before, after), [{ pane: 0, from: "support agent", to: "beth studio", fromEmpty: true }]);
});

test("movedPanes: nada se nada mudou de aba, e nome vazio vira Aba N", () => {
  let l = emptyLayout("");
  l = movePaneToTab(l, 1, l.tabs[0].id);
  assert.deepEqual(movedPanes(l, l), []);
  const l2 = addTab(l, "B");
  const l3 = movePaneToTab(l2, 1, l2.active);
  assert.deepEqual(movedPanes(l2, l3), [{ pane: 1, from: "Aba 1", to: "B", fromEmpty: true }]);
});

test("layoutSummary: abas com nome, sem nome e com divisão", () => {
  let l = emptyLayout("ORACULO");
  l = movePaneToTab(l, 4, l.tabs[0].id);
  l = addTab(l, "", 21);
  l = addTab(l, "beth studio", 3);
  l = movePaneToTab(l, 0, l.active); // 3 e 0 lado a lado
  assert.equal(layoutSummary(l), "ORACULO[4] | Aba 2[21] | beth studio[3,0]");
});

test("parseOpenParam: sem open= não é o terminal 0 (Number('') vale 0)", () => {
  assert.deepEqual(parseOpenParam(null), []);
  assert.deepEqual(parseOpenParam(""), []);
  assert.deepEqual(parseOpenParam("  "), []);
  assert.deepEqual(parseOpenParam("0"), [0]);
  assert.deepEqual(parseOpenParam("9, 10"), [9, 10]);
  assert.deepEqual(parseOpenParam("9,,abc,-1,2.5,3"), [9, 3]);
});
