// Tela de abertura do Studio: etapa atual, quando termina e a linha do log.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { markScreen, screenedPanes, startupItems, startupLogLine, startupStage } from "../src/lib/startup.ts";

const base = { socket: "open" as const, paneCount: 42, layoutReady: true, activePanes: [1, 2, 3], screened: new Set<number>(), stageMs: 0 };

test("etapas na ordem: conectar, lista, organização, telas, pronto", () => {
  assert.equal(startupStage({ ...base, socket: "connecting" }).key, "connect");
  assert.equal(startupStage({ ...base, paneCount: null }).key, "list");
  assert.equal(startupStage({ ...base, layoutReady: false }).key, "layout");
  const s = startupStage({ ...base, screened: new Set([1]) });
  assert.equal(s.key, "screens");
  assert.match(s.text, /1 de 3/);
  assert.equal(startupStage({ ...base, screened: new Set([1, 2, 3]) }).done, true);
  assert.equal(startupStage({ ...base, activePanes: [] }).done, true); // aba vazia
});

test("demora: aviso depois de 10 s; telas desistem de esperar aos 15 s", () => {
  assert.equal(startupStage({ ...base, socket: "closed", stageMs: 3000 }).slow, false);
  const slow = startupStage({ ...base, socket: "closed", stageMs: 11000 });
  assert.equal(slow.slow, true);
  assert.equal(slow.action, "retry");
  assert.equal(startupStage({ ...base, stageMs: 11000 }).action, "skip");
  assert.equal(startupStage({ ...base, stageMs: 16000 }).done, true);
});

test("registro de telas recebidas", () => {
  markScreen(7);
  assert.ok(screenedPanes().has(7));
});

test("linha do log com o tempo de cada fase", () => {
  assert.equal(
    startupLogLine({ connect: 1234, list: 3400, layout: 3500, screens: 5020 }, 42, 3, 3),
    "abertura (página): conectado 1,23s · lista 3,40s (42 terminais) · organização 3,50s · telas 5,02s (3 de 3)",
  );
});

test("UI: splash no index.html e overlay no App", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /id="boot"/);
  assert.match(html, /Abrindo Beth Studio/);
  const app = fs.readFileSync("src/App.tsx", "utf8");
  assert.match(app, /<StartupOverlay/);
  assert.match(fs.readFileSync("src/components/TerminalView.tsx", "utf8"), /markScreen\(paneId\)/);
});

test("abertura lista os terminais da aba com o que falta primeiro", () => {
  const all = [
    { id: 1, label: "PowerShell" },
    { id: 2, label: "WSL · Ubuntu" },
    { id: 3, label: "SSH · srv" },
  ];
  const r = startupItems("screens", all, [1, 2, 3], new Set([1]));
  assert.deepEqual(
    r.items.map((i) => [i.id, i.state]),
    [
      [2, "wait"],
      [3, "wait"],
      [1, "ok"],
    ],
  );
  assert.equal(r.more, 0);
});

test("abertura sem nome conhecido usa 'Terminal N'; antes da organização lista todos", () => {
  assert.equal(startupItems("screens", [], [7], new Set()).items[0].label, "Terminal 7");
  const all = [{ id: 1, label: "a" }, { id: 2, label: "b" }];
  assert.equal(startupItems("layout", all, [], new Set()).items.length, 2);
  assert.equal(startupItems("connect", all, [], new Set()).items.length, 0);
});

test("abertura corta a lista longa e diz quantos faltam mostrar", () => {
  const all = Array.from({ length: 30 }, (_, i) => ({ id: i, label: `t${i}` }));
  const r = startupItems("layout", all, [], new Set());
  assert.equal(r.items.length, 12);
  assert.equal(r.more, 18);
});
