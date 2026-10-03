// "Por pasta" na barra lateral e o nome da pasta em destaque nos cartões.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { groupByFolder, splitCwd } from "../src/lib/folders.ts";
import type { PaneInfo } from "../src/lib/types.ts";

let n = 0;
const pane = (cwd: string, title = "t"): PaneInfo =>
  ({ pane_id: ++n, window_id: 1, tab_id: 1, workspace: "default", size: { rows: 24, cols: 80 }, title, cwd, cursor_x: 0, cursor_y: 0, tab_title: "", window_title: "", is_active: true, is_zoomed: false }) as PaneInfo;

test("cartão: pasta em destaque, o começo do caminho apagado", () => {
  assert.deepEqual(splitCwd("file://pc/home/dev/work/repo/web-server"), { parent: "~/work/repo/", name: "web-server" });
  assert.deepEqual(splitCwd("file://pc/usr/local/work/repo/infra/network"), { parent: "…/work/repo/infra/", name: "network" });
  assert.deepEqual(splitCwd("file:///C:/Users/dev/proj/"), { parent: "~\\", name: "proj" });
  assert.deepEqual(splitCwd("file://pc/home/dev"), { parent: "", name: "~" });
  assert.deepEqual(splitCwd(""), { parent: "", name: "" });
});

test("por pasta: agrupa pelo caminho inteiro, rótulo = nome da pasta, ordem alfabética", () => {
  const g = groupByFolder([
    pane("file://pc/home/dev/work/repo/web-server", "Web module"),
    pane("file://pc/home/dev/work/repo/alpha-docs", "Docs"),
    pane("file://pc/home/dev/work/repo/web-server/", "Billing"),
    pane("", "sem pasta"),
    pane("file:///C:/src/demo/Bravo", "win"),
  ]);
  assert.deepEqual(
    g.map((x) => [x.label, x.panes.map((p) => p.title)]),
    [
      ["alpha-docs", ["Docs"]],
      ["Bravo", ["win"]],
      ["web-server", ["Web module", "Billing"]],
      ["Sem pasta", ["sem pasta"]],
    ],
  );
  assert.equal(g[2].path, "~/work/repo/web-server");
});

test("por pasta: nomes iguais em lugares diferentes ganham o pai", () => {
  const g = groupByFolder([pane("file://pc/home/dev/a/src"), pane("file://pc/home/dev/b/src"), pane("file://pc/opt/x")]);
  assert.deepEqual(g.map((x) => x.label).sort(), ["a/src", "b/src", "x"]);
});

test("por pasta: pasta do Windows não diferencia maiúsculas", () => {
  const g = groupByFolder([pane("file:///C:/Repo/App"), pane("file:///c:/repo/app")]);
  assert.equal(g.length, 1);
  assert.equal(g[0].panes.length, 2);
});

test("barra lateral: modo Por pasta ligado (UI, configuração e Go)", () => {
  const sb = fs.readFileSync("src/components/Sidebar.tsx", "utf8");
  assert.match(sb, /"folder"/);
  assert.match(sb, /groupByFolder\(/);
  assert.match(sb, /splitCwd\(/);
  assert.match(fs.readFileSync("src/components/SettingsDialog.tsx", "utf8"), /view: "folder"/);
  assert.match(fs.readFileSync("../settings.go", "utf8"), /"kind", "folder"/);
});
