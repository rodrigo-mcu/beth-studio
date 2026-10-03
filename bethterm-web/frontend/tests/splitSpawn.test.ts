// "Novo terminal à direita/abaixo/acima/à esquerda": modelo + fluxo.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyLayout,
  findPane,
  insertPlaceholder,
  leaves,
  movePaneToTab,
  removePlaceholder,
  resolvePlaceholder,
  sanitize,
  stripPlaceholders,
  type Layout,
  type LayoutNode,
} from "../src/lib/layout.ts";
import { sameShellId, splitAround, splitSpawn, type SplitSpawnDeps } from "../src/lib/splitSpawn.ts";
import type { SpawnedEvent } from "../src/lib/types.ts";

function show(n: LayoutNode | null): string {
  if (!n) return "-";
  if (n.type === "leaf") return String(n.pane);
  return `${n.dir}(${n.children.map(show).join(",")})`;
}
const root = (l: Layout) => show(l.tabs.find((t) => t.id === l.active)!.root);
const sizes = (l: Layout) => {
  const r = l.tabs.find((t) => t.id === l.active)!.root;
  return r && r.type === "split" ? r.sizes : [];
};

function twoPanes(): Layout {
  let l = emptyLayout();
  l = movePaneToTab(l, 1, l.active);
  l = movePaneToTab(l, 2, l.active); // row(1,2)
  return l;
}

test("marcador em cada direção, ao lado do alvo, 50/50", () => {
  const l = twoPanes();
  assert.equal(root(insertPlaceholder(l, 1, "right", -1)!), "row(1,-1,2)");
  assert.equal(root(insertPlaceholder(l, 1, "left", -1)!), "row(-1,1,2)");
  assert.equal(root(insertPlaceholder(l, 2, "bottom", -1)!), "row(1,col(2,-1))");
  assert.equal(root(insertPlaceholder(l, 2, "top", -1)!), "row(1,col(-1,2))");
  // alvo com 1/2 da largura: a metade dele vai para o novo (1/4 + 1/4)
  assert.deepEqual(sizes(insertPlaceholder(l, 1, "right", -1)!), [0.25, 0.25, 0.5]);
  // aba com um so' terminal
  let one = emptyLayout();
  one = movePaneToTab(one, 7, one.active);
  const b = insertPlaceholder(one, 7, "bottom", -3)!;
  assert.equal(root(b), "col(7,-3)");
  assert.deepEqual(sizes(b), [0.5, 0.5]);
});

test("marcador: alvo fora do layout ou id nao negativo = null", () => {
  const l = twoPanes();
  assert.equal(insertPlaceholder(l, 99, "right", -1), null);
  assert.equal(insertPlaceholder(l, 1, "right", 5), null);
});

test("resolver troca o marcador pelo pane real no mesmo lugar", () => {
  const l = insertPlaceholder(twoPanes(), 2, "bottom", -4)!;
  const r = resolvePlaceholder(l, -4, 100);
  assert.equal(root(r), "row(1,col(2,100))");
  assert.equal(findPane(r, -4), null);
});

test("resolver sem marcador (organização trocada) poe ao lado do alvo", () => {
  const l = twoPanes();
  assert.equal(root(resolvePlaceholder(l, -9, 100, 1, "right")), "row(1,100,2)");
  // alvo tambem sumiu: nada muda
  assert.equal(root(resolvePlaceholder(l, -9, 100, 55, "right")), "row(1,2)");
  // pane ja' organizado: so' tira o marcador
  const m = insertPlaceholder(l, 1, "top", -2)!;
  assert.equal(root(resolvePlaceholder(m, -2, 2)), "row(1,2)");
});

test("remover e nunca gravar marcadores", () => {
  const l = insertPlaceholder(insertPlaceholder(twoPanes(), 1, "right", -1)!, 2, "bottom", -2)!;
  assert.equal(root(removePlaceholder(l, -1)), "row(1,col(2,-2))");
  const s = stripPlaceholders(l);
  assert.equal(root(s), "row(1,2)");
  assert.ok(leaves(s.tabs[0].root).every((x) => x.leaf.pane >= 0));
  // o que vem do disco tambem descarta pane < 0
  assert.equal(root(sanitize(JSON.parse(JSON.stringify(l)))!), "row(1,2)");
});

test("mesmo tipo deste: shell da GUI pelo tipo do terminal", () => {
  const shells = ["cmd", "powershell", "pwsh", "wsl.default", "wsl.ubuntu", "gitbash", "mobaxterm.local"].map((id) => ({ id, label: id }));
  assert.equal(sameShellId({ kind: "cmd" }, shells), "cmd");
  assert.equal(sameShellId({ kind: "pwsh" }, shells), "pwsh");
  assert.equal(sameShellId({ kind: "wsl", distro: "Ubuntu" }, shells), "wsl.ubuntu");
  assert.equal(sameShellId({ kind: "wsl", distro: "Debian" }, shells), "wsl.default");
  assert.equal(sameShellId({ kind: "wsl" }, shells), "wsl.default");
  assert.equal(sameShellId({ kind: "gitbash" }, shells), "gitbash");
  assert.equal(sameShellId({ kind: "mobaxterm" }, shells), "mobaxterm.local");
  assert.equal(sameShellId({ kind: "unknown" }, shells), null);
  assert.equal(sameShellId({ kind: "cmd" }, null), null);
});

/** Organizacao em memoria + spawn falso. */
function harness(spawn: SplitSpawnDeps["spawn"], timeoutMs?: number) {
  let layout: Layout = twoPanes();
  const commits: { l: string; delay: number }[] = [];
  const errors: string[] = [];
  const deps: SplitSpawnDeps = {
    spawn,
    getLayout: () => layout,
    commit: (l, delay) => {
      layout = l;
      commits.push({ l: root(l), delay });
    },
    onError: (m) => errors.push(m),
    timeoutMs,
  };
  return {
    deps,
    commits,
    errors,
    get layout() {
      return layout;
    },
  };
}

test("fluxo: marcador so' local, depois o pane real gravado; spawn com a janela e a pasta do alvo", async () => {
  const calls: unknown[] = [];
  const h = harness(async (o) => {
    calls.push(o);
    return {
      ev: "spawned",
      pane_id: 100,
      tab_id: 5,
      window_id: 3,
    } as SpawnedEvent;
  });
  const got = await splitSpawn(h.deps, { pane_id: 1, window_id: 3, cwd: "file://pc/C:/src/repo" }, "bottom", "wsl.ubuntu");
  assert.equal(got, 100);
  assert.deepEqual(calls, [{ shell_id: "wsl.ubuntu", window_id: 3, cwd: "/mnt/c/src/repo" }]);
  assert.equal(h.commits.length, 2);
  assert.equal(h.commits[0].delay, -1);
  assert.match(h.commits[0].l, /-\d+/);
  assert.deepEqual(h.commits[1], { l: "row(col(1,100),2)", delay: 0 });
  assert.deepEqual(h.errors, []);
});

test("fluxo: erro do BethTerm tira o marcador e avisa", async () => {
  const h = harness(async () => {
    throw new Error("falha simulada");
  });
  assert.equal(await splitSpawn(h.deps, { pane_id: 2, window_id: 1, cwd: "" }, "right", "cmd"), null);
  assert.equal(root(h.layout), "row(1,2)");
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /falha simulada/);
});

test("fluxo: tempo esgotado tira o marcador e avisa", async () => {
  const h = harness(() => new Promise<SpawnedEvent>(() => {}), 30);
  const t0 = Date.now();
  assert.equal(await splitSpawn(h.deps, { pane_id: 1, window_id: 1, cwd: "" }, "left", "cmd"), null);
  assert.ok(Date.now() - t0 >= 25);
  assert.equal(root(h.layout), "row(1,2)");
  assert.match(h.errors[0], /não respondeu/);
});

test("fluxo: SSH no split usa o start informado e encaixa ao lado", async () => {
  let layout: Layout = twoPanes();
  const calls: string[] = [];
  const pane = await splitAround(
    {
      start: async () => {
        calls.push("ssh");
        return { ev: "spawned", pane_id: 77, tab_id: 1, window_id: 3 } as SpawnedEvent;
      },
      getLayout: () => layout,
      commit: (l) => {
        layout = l;
      },
    },
    { pane_id: 1, window_id: 3, cwd: "" },
    "right",
    "root@host:22",
  );
  assert.equal(pane, 77);
  assert.deepEqual(calls, ["ssh"]);
  assert.equal(root(layout), "row(1,77,2)");
});

test("fluxo: o split só é gravado depois que o pane entra na lista", async () => {
  const calls: number[] = [];
  let layout: Layout = twoPanes();
  let release: () => void = () => {};
  const listed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pane = splitAround(
    {
      start: async () => ({ ev: "spawned", pane_id: 55, tab_id: 1, window_id: 1 }) as SpawnedEvent,
      getLayout: () => layout,
      commit: (l, delay) => {
        layout = l;
        calls.push(delay);
      },
      untilListed: () => listed,
    },
    { pane_id: 1, window_id: 1, cwd: "" },
    "right",
    "ssh",
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, [-1]);
  assert.match(root(layout), /-\d+/);
  release();
  assert.equal(await pane, 55);
  assert.deepEqual(calls, [-1, 0]);
  assert.equal(root(layout), "row(1,55,2)");
});

test("fluxo: alvo fora de aba do web nao chama spawn", async () => {
  let called = false;
  const h = harness(async () => {
    called = true;
    return {
      ev: "spawned",
      pane_id: 1,
      tab_id: 1,
      window_id: 1,
    } as SpawnedEvent;
  });
  assert.equal(await splitSpawn(h.deps, { pane_id: 42, window_id: 1, cwd: "" }, "right", "cmd"), null);
  assert.equal(called, false);
  assert.equal(h.errors.length, 1);
});
