// "Reiniciar este terminal": o novo nasce antes, ocupa a folha do antigo,
// e so' entao o antigo e' encerrado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyLayout, findPane, leaves, movePaneToTab, renameTab, type Layout, type LayoutNode } from "../src/lib/layout.ts";
import { restartPane, type RestartDeps } from "../src/lib/restartPane.ts";
import type { SpawnedEvent } from "../src/lib/types.ts";

function show(n: LayoutNode | null): string {
  if (!n) return "-";
  if (n.type === "leaf") return String(n.pane);
  return `${n.dir}(${n.children.map(show).join(",")})`;
}

function harness(l0: Layout, spawn: RestartDeps["spawn"]) {
  let layout: Layout | null = l0;
  const ended: number[] = [];
  const spawned: unknown[] = [];
  const deps: RestartDeps = {
    spawn: (o) => (spawned.push(o), spawn(o)),
    untilListed: async () => undefined,
    getLayout: () => layout,
    commit: (l) => (layout = l),
    end: (p) => ended.push(p),
    timeoutMs: 50,
  };
  return { deps, ended, spawned, layout: () => layout! };
}

const old = { pane_id: 2, window_id: 7, cwd: "file:///C:/mcu/rodrigo-diario-audio/assistente/" };

function twoPanes(): Layout {
  let l = emptyLayout();
  l = movePaneToTab(l, 1, l.active);
  l = movePaneToTab(l, 2, l.active); // row(1,2)
  return renameTab(l, l.active, "Assistente");
}

test("novo shell na mesma folha, mesma janela e pasta; depois encerra o antigo", async () => {
  const h = harness(twoPanes(), async () => ({ pane_id: 9 }) as SpawnedEvent);
  const pane = await restartPane(h.deps, old, "pwsh");
  assert.equal(pane, 9);
  const tab = h.layout().tabs[0];
  assert.equal(show(tab.root), "row(1,9)");
  assert.equal(tab.name, "Assistente");
  assert.equal(findPane(h.layout(), 2), null);
  assert.deepEqual(h.ended, [2]);
  assert.deepEqual(h.spawned, [{ shell_id: "pwsh", window_id: 7, cwd: "C:\\mcu\\rodrigo-diario-audio\\assistente" }]);
});

test("se o shell novo falha, nada e' encerrado e a aba nao muda", async () => {
  const h = harness(twoPanes(), async () => {
    throw new Error("spawn falhou");
  });
  await assert.rejects(restartPane(h.deps, old, "pwsh"), /spawn falhou/);
  assert.deepEqual(h.ended, []);
  assert.equal(show(h.layout().tabs[0].root), "row(1,2)");
});

test("se o host nao responde, nada e' encerrado", async () => {
  const h = harness(twoPanes(), () => new Promise<SpawnedEvent>(() => undefined));
  await assert.rejects(restartPane(h.deps, old, "pwsh"), /não respondeu/);
  assert.deepEqual(h.ended, []);
});

test("antigo fora de qualquer aba: o novo fica em Não organizados e o antigo e' encerrado", async () => {
  let l = emptyLayout();
  l = movePaneToTab(l, 1, l.active);
  const h = harness(l, async () => ({ pane_id: 9 }) as SpawnedEvent);
  await restartPane(h.deps, old, "pwsh");
  assert.deepEqual(leaves(h.layout().tabs[0].root).map((x) => x.leaf.pane), [1]);
  assert.deepEqual(h.ended, [2]);
});
