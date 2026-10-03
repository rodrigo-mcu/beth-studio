import { test } from "node:test";
import assert from "node:assert/strict";
import { countKinds, groupByKind, passesKindFilter } from "../src/lib/kinds.ts";
import { search, type SearchEntry } from "../src/lib/search.ts";
import type { PaneInfo } from "../src/lib/types.ts";

const P = (pane_id: number, kind: string, extra: Partial<PaneInfo> = {}) =>
  ({ pane_id, kind, title: `t${pane_id}`, cwd: "", ...extra }) as PaneInfo;

const panes = [
  P(1, "powershell"),
  P(2, "pwsh"),
  P(3, "wsl", { distro: "Ubuntu", agent: true, title: "✳ Claude refatorar" }),
  P(4, "wsl"),
  P(5, "cmd"),
  P(6, "mobaxterm"),
  P(7, "unknown", { agent: true }),
];

test("filtro por tipo: OU entre tipos, E com 'agentes', vazio = todos", () => {
  const ids = (sel: string[]) => panes.filter((p) => passesKindFilter(p, sel)).map((p) => p.pane_id);
  assert.deepEqual(ids([]), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(ids(["powershell"]), [1, 2]); // pwsh entra em PowerShell
  assert.deepEqual(ids(["wsl", "cmd"]), [3, 4, 5]);
  assert.deepEqual(ids(["agent"]), [3, 7]);
  assert.deepEqual(ids(["wsl", "agent"]), [3]);
  assert.deepEqual(ids(["other"]), [6]);
});

test("contagem por tipo", () => {
  const c = countKinds(panes);
  assert.deepEqual(c, { wsl: 2, powershell: 2, cmd: 1, gitbash: 0, ssh: 0, serial: 0, other: 1, unknown: 1, agent: 2 });
});

test("agrupar por tipo e, em WSL, por distro", () => {
  const g = groupByKind(panes);
  assert.deepEqual(
    g.map((s) => [s.key, s.panes.map((p) => p.pane_id)]),
    [
      ["wsl", [3, 4]],
      ["powershell", [1, 2]],
      ["cmd", [5]],
      ["other", [6]],
      ["unknown", [7]],
    ],
  );
  assert.deepEqual(
    g[0].distros?.map((d) => [d.distro, d.panes.map((p) => p.pane_id)]),
    [
      ["padrão", [4]],
      ["Ubuntu", [3]],
    ],
  );
  // so' a distro padrao: sem subgrupos
  assert.equal(groupByKind([P(9, "wsl")])[0].distros, undefined);
});

test("filtro combinado com a busca", () => {
  const entries: SearchEntry[] = panes.map((p) => ({
    pane: p.pane_id,
    gone: false,
    fields: [{ kind: "title", label: "Título", text: p.title }],
  }));
  const byId = new Map(panes.map((p) => [p.pane_id, p]));
  const run = (q: string, sel: string[]) =>
    search(entries, q)
      .filter((r) => passesKindFilter(byId.get(r.entry.pane)!, sel))
      .map((r) => r.entry.pane);
  assert.deepEqual(run("t4", ["wsl"]), [4]);
  assert.deepEqual(run("t4", ["cmd"]), []);
  assert.deepEqual(run("claude", ["wsl", "agent"]), [3]);
  assert.deepEqual(run("claude", ["cmd"]), []);
});

test("SSH por host e ordem configurável dos grupos", async () => {
  const { kindOrder, moveItem, KIND_ORDER } = await import("../src/lib/kinds.ts");
  assert.deepEqual(KIND_ORDER, ["wsl", "powershell", "cmd", "gitbash", "ssh", "serial", "other", "unknown"]);
  assert.deepEqual(kindOrder(["ssh", "xyz", "wsl"]), ["ssh", "wsl", "powershell", "cmd", "gitbash", "serial", "other", "unknown"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 2, 0), ["c", "a", "b"]);
  assert.deepEqual(moveItem(["a", "b"], 0, -1), ["a", "b"]);
  const panes = [
    P(1, "powershell"),
    P(2, "ssh", { ssh_host: "web01" }),
    P(3, "wsl", { distro: "Debian" }),
    P(4, "ssh", { ssh_host: "db" }),
    P(5, "ssh", { ssh_host: "web01" }),
    P(6, "pwsh"),
  ];
  const secs = groupByKind(panes);
  assert.deepEqual(
    secs.map((s) => s.key),
    ["wsl", "powershell", "ssh"],
  );
  const ssh = secs.find((s) => s.key === "ssh")!;
  assert.deepEqual(
    ssh.distros!.map((d) => [d.distro, d.panes.map((p) => p.pane_id)]),
    [
      ["db", [4]],
      ["web01", [2, 5]],
    ],
  );
  assert.deepEqual(
    groupByKind(panes, ["ssh", "powershell"]).map((s) => s.key),
    ["ssh", "powershell", "wsl"],
  );
  assert.equal(countKinds(panes).ssh, 3);
  assert.ok(passesKindFilter(panes[1], ["ssh"]));
  assert.ok(!passesKindFilter(panes[0], ["ssh"]));
});

test("Serial: grupo próprio depois de SSH", async () => {
  const { kindGroup } = await import("../src/lib/kinds.ts");
  const panes = [P(1, "serial", { kind_label: "Serial · COM3" }), P(2, "ssh", { ssh_host: "srv" }), P(3, "cmd")];
  assert.equal(kindGroup(panes[0]), "serial");
  assert.deepEqual(
    groupByKind(panes).map((s) => s.key),
    ["cmd", "ssh", "serial"],
  );
  assert.equal(countKinds(panes).serial, 1);
});
