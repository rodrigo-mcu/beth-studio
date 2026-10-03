import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatBytes,
  formatPct,
  formatRate,
  formatUptime,
  nextSort,
  pctOf,
  sortTerminals,
  historySeries,
  sparklinePoints,
  swapsByPriority,
  zramRatio,
  termKey,
  type TermStat,
} from "../src/lib/sysmon.ts";

// Intl pt-BR usa espaco comum entre numero e unidade (a gente monta a string).
test("formatBytes: base 1024, virgula decimal", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1,5 KB");
  assert.equal(formatBytes(700 * 1024 * 1024), "700 MB");
  assert.equal(formatBytes(5.5 * 1024 * 1024), "5,5 MB");
  assert.equal(formatBytes(16 * 1024 ** 3), "16,0 GB");
  assert.equal(formatBytes(1.5 * 1024 ** 4), "1,5 TB");
  assert.equal(formatBytes(-1), "—");
  assert.equal(formatBytes(undefined), "—");
  assert.equal(formatRate(2048), "2,0 KB/s");
});

test("formatPct e formatUptime", () => {
  assert.equal(formatPct(12.345), "12,3%");
  assert.equal(formatPct(0), "0%");
  assert.equal(formatPct(0.04), "<0,1%");
  assert.equal(formatPct(null), "—");
  assert.equal(formatUptime(59), "0min");
  assert.equal(formatUptime(3 * 3600 + 120), "3h 2min");
  assert.equal(formatUptime(90061), "1d 1h 1min");
  assert.equal(pctOf(1, 4), 25);
  assert.equal(pctOf(5, 0), 0);
  assert.equal(pctOf(9, 4), 100);
});

const T = (pane_id: number | null, title: string, extra: Partial<TermStat> = {}): TermStat => ({
  pane_id,
  title,
  kind: "wsl",
  kind_label: "WSL",
  match: "exato",
  match_label: "título exato",
  ws: 0,
  private_ws: 0,
  private: 0,
  cpu: 0,
  procs: 1,
  top: [],
  ...extra,
});

const list = [
  T(1, "beta", { private_ws: 100, cpu: 5, procs: 3, kind_label: "PowerShell 5.1" }),
  T(2, "Alfa", { private_ws: 300, cpu: 1, procs: 1 }),
  T(null, "Não associado: cmd", { private_ws: 50, cpu: 9, procs: 2, shell_pid: 77, kind_label: "cmd" }),
  T(3, "terminal 10", { private_ws: 100, cpu: 0, procs: 3 }),
  T(4, "terminal 9", { private_ws: 0, cpu: 0, procs: 0 }),
];

test("sortTerminals: por coluna, sem mutar, empates estaveis", () => {
  const ids = (xs: TermStat[]) => xs.map(termKey);
  assert.deepEqual(ids(sortTerminals(list, "ram", "desc")), ["p2", "p1", "p3", "s77", "p4"]);
  assert.deepEqual(ids(sortTerminals(list, "ram", "asc")), ["p4", "s77", "p1", "p3", "p2"]);
  assert.deepEqual(ids(sortTerminals(list, "cpu", "desc")), ["s77", "p1", "p2", "p3", "p4"]);
  // numerico dentro do texto: "terminal 9" antes de "terminal 10"; sem caixa
  assert.deepEqual(ids(sortTerminals(list, "title", "asc")), ["p2", "p1", "s77", "p4", "p3"]);
  assert.deepEqual(ids(sortTerminals(list, "procs", "desc")), ["p1", "p3", "s77", "p2", "p4"]);
  assert.deepEqual(ids(sortTerminals(list, "kind", "asc")), ["s77", "p1", "p2", "p3", "p4"]);
  assert.equal(list[0].pane_id, 1, "a lista original nao muda");
});

test("nextSort: mesmo cabecalho inverte; outro cabecalho usa o padrao", () => {
  assert.deepEqual(nextSort({ key: "ram", dir: "desc" }, "ram"), { key: "ram", dir: "asc" });
  assert.deepEqual(nextSort({ key: "ram", dir: "desc" }, "title"), { key: "title", dir: "asc" });
  assert.deepEqual(nextSort({ key: "title", dir: "asc" }, "cpu"), { key: "cpu", dir: "desc" });
});

test("historySeries: ignora o comeco sem dado e segura o ultimo no buraco", () => {
  const pts = [
    { ok: false, v: 0 },
    { ok: true, v: 10 },
    { ok: false, v: 0 },
    { ok: true, v: 30 },
  ];
  assert.deepEqual(historySeries(pts), [10, 10, 30]);
  assert.deepEqual(historySeries([{ ok: false, v: 1 }]), []);
  assert.deepEqual(historySeries([{ ok: true, v: 4 }, { ok: true, v: 5 }], 1), [5]);
});

test("sparklinePoints: alinhado a direita, limitado a 0..100", () => {
  assert.equal(sparklinePoints([], 100, 20), "");
  assert.equal(sparklinePoints([0, 100], 10, 20, 2), "0.0,20.0 10.0,0.0");
  assert.equal(sparklinePoints([150], 10, 20, 2), "10.0,0.0");
  assert.equal(sparklinePoints([50, 50, 50], 20, 10, 3).split(" ").length, 3);
});

test("swapsByPriority e zramRatio", () => {
  const z = { name: "/dev/zram0", kind: "zram" as const, size: 16, used: 4 * 1024 ** 3, prio: 100, zram_phys: 1024 ** 3 };
  const f = { name: "/swapfile", kind: "file" as const, size: 16, used: 0, prio: 10 };
  assert.deepEqual(swapsByPriority([f, z]).map((s) => s.prio), [100, 10]);
  assert.deepEqual(swapsByPriority(null), []);
  assert.equal(zramRatio(z), "4,0:1");
  assert.equal(zramRatio({ used: 1024, zram_phys: 10 }), "");
  assert.equal(zramRatio({ used: 4 * 1024 ** 3 }), "");
});
