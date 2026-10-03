import { test } from "node:test";
import assert from "node:assert/strict";
import { QUICK_KEYS, waitedFor } from "../src/phone/text.ts";

test("waitedFor", () => {
  const now = 10 * 3600_000;
  assert.equal(waitedFor(now - 20_000, now), "agora");
  assert.equal(waitedFor(now - 4 * 60_000, now), "há 4 min");
  assert.equal(waitedFor(now - 2 * 3600_000, now), "há 2 h");
  assert.equal(waitedFor(now + 5000, now), "agora");
});

test("teclas rápidas mandam o código certo", () => {
  const by = Object.fromEntries(QUICK_KEYS.map((k) => [k.label, k.data]));
  assert.equal(by.Enter, "\r");
  assert.equal(by.Esc, "\x1b");
  assert.equal(by["↑"], "\x1b[A");
  assert.equal(by["1"], "1");
});

import { cleanTitle, kindText, screenLines } from "../src/phone/text.ts";

test("cleanTitle tira o status do agente", () => {
  assert.equal(cleanTitle("✳ Lista de servidores"), "Lista de servidores");
  assert.equal(cleanTitle("◐ Claude Code"), "Claude Code");
  assert.equal(cleanTitle("⠋ trabalhando"), "trabalhando");
  assert.equal(cleanTitle("PowerShell 5.1"), "PowerShell 5.1");
  assert.equal(cleanTitle("✳"), "✳");
});

test("kindText", () => {
  assert.equal(kindText("Desconhecido", false), "Terminal");
  assert.equal(kindText("", true), "Agente");
  assert.equal(kindText("WSL", false), "WSL");
});

test("screenLines: régua vira divisor", () => {
  const l = screenLines("oi\n" + "─".repeat(120) + "\n❯ \n-- x");
  assert.deepEqual(l[0], { rule: false, text: "oi" });
  assert.deepEqual(l[1], { rule: true });
  assert.equal(l[2].rule, false);
  assert.equal(l[3].rule, false);
});

import { filterPanes, kindChips } from "../src/phone/text.ts";

const P = [
  { pane_id: 1, title: "✳ Agente de nuvem", cwd: "file://wsl/home/r/api-server", kind: "wsl", kind_label: "WSL", agent: true },
  { pane_id: 2, title: "PowerShell 5.1", cwd: "file:///C:/Users/r", kind: "powershell", kind_label: "PowerShell 5.1" },
  { pane_id: 3, title: "pwsh", cwd: "file:///C:/demo", kind: "pwsh", kind_label: "PowerShell 7" },
  { pane_id: 4, title: "root@srv", cwd: "", kind: "ssh", ssh_host: "root@srv:22" },
];
const lbl = (p: { title: string }) => p.title;

test("filterPanes por tipo", () => {
  assert.deepEqual(filterPanes(P, "", "powershell", lbl).map((p) => p.pane_id), [2, 3]);
  assert.deepEqual(filterPanes(P, "", "agent", lbl).map((p) => p.pane_id), [1]);
  assert.deepEqual(filterPanes(P, "", "all", lbl).length, 4);
});

test("filterPanes por texto, sem acento e com várias palavras", () => {
  assert.deepEqual(filterPanes(P, "nuvem api", "all", lbl).map((p) => p.pane_id), [1]);
  assert.deepEqual(filterPanes(P, "srv", "all", lbl).map((p) => p.pane_id), [4]);
  assert.deepEqual(filterPanes(P, "demo", "powershell", lbl).map((p) => p.pane_id), [3]);
});

test("kindChips só mostra tipos presentes", () => {
  assert.deepEqual(kindChips(P), ["all", "agent", "wsl", "powershell", "ssh"]);
});

import { byRecent, touchRecent } from "../src/phone/text.ts";

test("byRecent: o último aberto vai para o topo", () => {
  const l = [{ pane_id: 1 }, { pane_id: 2 }, { pane_id: 3 }, { pane_id: 4 }];
  let r = touchRecent({}, 3, 100);
  r = touchRecent(r, 1, 200);
  assert.deepEqual(byRecent(l, r).map((p) => p.pane_id), [1, 3, 2, 4]);
  r = touchRecent(r, 3, 300);
  assert.deepEqual(byRecent(l, r).map((p) => p.pane_id), [3, 1, 2, 4]);
});

test("touchRecent esquece terminais fechados", () => {
  const r = touchRecent({ 1: 5, 9: 6 }, 2, 10, new Set([1, 2]));
  assert.deepEqual(r, { 1: 5, 2: 10 });
});
