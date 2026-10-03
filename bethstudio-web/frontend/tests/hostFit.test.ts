import { test } from "node:test";
import assert from "node:assert/strict";
import { aloneInHostTab, effectiveSizeMode, FitGovernor, fontForWidth, gridFor, resizeRefusedPane } from "../src/lib/hostFit.ts";
import type { PaneInfo } from "../src/lib/types.ts";

test("cols/rows pela celula real, com limites 10-500 x 4-300", () => {
  assert.deepEqual(gridFor(1000, 600, 12, 24), { cols: 83, rows: 25 });
  assert.deepEqual(gridFor(1000, 600, 12.5, 25), { cols: 80, rows: 24 }); // divisao exata
  assert.deepEqual(gridFor(50, 30, 12, 24), { cols: 10, rows: 4 });
  assert.deepEqual(gridFor(100000, 100000, 5, 5), { cols: 500, rows: 300 });
  assert.equal(gridFor(1000, 600, 0, 24), null);
});

const pane = (pane_id: number, tab_id: number) => ({ pane_id, tab_id }) as PaneInfo;

test("sozinho na aba do host e modo efetivo", () => {
  const panes = [pane(1, 10), pane(2, 11), pane(3, 11)];
  assert.equal(aloneInHostTab(panes, 1), true);
  assert.equal(aloneInHostTab(panes, 2), false);
  assert.equal(aloneInHostTab(panes, 9), false);
  assert.equal(effectiveSizeMode(undefined, true), "fit");
  assert.equal(effectiveSizeMode("host", true), "host");
  assert.equal(effectiveSizeMode("fit", false), "host"); // split no host: so' espelhar
});

test("anti-loop: nao repete o pedido nem briga com a GUI", () => {
  const g = new FitGovernor();
  const host = { cols: 115, rows: 32 };
  const want = { cols: 140, rows: 40 };
  assert.deepEqual(g.request(want, host, "open", 0), want); // manda
  assert.equal(g.request(want, host, "area", 100), null); // mesmo pedido pendente: nao repete
  g.hostSize(host, 200); // tela antiga chegando: ignora
  assert.equal(g.divergent, false);
  g.hostSize(want, 300); // host aplicou
  assert.equal(g.divergent, false);
  // A GUI mudou o tamanho depois: marca divergente e NAO reenvia sozinho
  g.hostSize({ cols: 100, rows: 30 }, 5000);
  assert.equal(g.divergent, true);
  // telas seguintes com o tamanho da GUI continuam sem pedido novo (nao ha' chamada de request)
  // O usuario clica "Reajustar": manda de novo
  assert.deepEqual(g.request(want, { cols: 100, rows: 30 }, "manual", 5100), want);
  assert.equal(g.divergent, false);
  // area igual ao host: nada a mandar
  assert.equal(g.request({ cols: 100, rows: 30 }, { cols: 100, rows: 30 }, "area", 9000), null);
});

test("pedido pendente expira: area mudou de novo depois de 1,5 s manda outra vez", () => {
  const g = new FitGovernor();
  const host = { cols: 80, rows: 24 };
  const want = { cols: 90, rows: 30 };
  assert.ok(g.request(want, host, "area", 0));
  assert.equal(g.request(want, host, "area", 1000), null);
  assert.ok(g.request(want, host, "area", 2000)); // host nunca aplicou (ex.: erro): tenta de novo
});

test("regra 'sozinho na aba do host' usa o tab_id do host; fit salvo e' ignorado em split", () => {
  // pane 10 e 11 na mesma aba do host (tab 10): so' "Igual ao Beth Studio"
  const panes = [pane(10, 10), pane(11, 10), pane(29, 23)];
  assert.equal(effectiveSizeMode("fit", aloneInHostTab(panes, 10)), "host");
  // o 11 fechou: o 10 fica sozinho e o "fit" salvo volta a valer
  assert.equal(effectiveSizeMode("fit", aloneInHostTab(panes.filter((p) => p.pane_id !== 11), 10)), "fit");
  assert.equal(resizeRefusedPane("resize: pane 10 shares its Beth Studio tab with 1 other pane(s)"), 10);
  assert.equal(resizeRefusedPane("resize: unknown pane 10"), null);
});

test("fonte nunca deixa o grid mais largo que a area", () => {
  // 228 colunas a 14px = 1915px de largura; area de 1000px
  assert.equal(fontForWidth(14, 14, 1915, 1000), 7);
  // quando o host passa a caber, volta a' preferida (nunca maior)
  assert.equal(fontForWidth(14, 7, 300, 1000), 14);
  // nem com 5px cabe: fica em 5 (ai' sim rolagem)
  assert.equal(fontForWidth(14, 14, 20000, 500), 5);
});

test("reajuste automatico com foco: 1 a cada 3 s, para depois de 3 em 30 s", () => {
  const g = new FitGovernor();
  const want = { cols: 140, rows: 40 };
  g.request(want, { cols: 80, rows: 24 }, "open", 0);
  g.hostSize(want, 100); // aplicado
  g.hostSize({ cols: 228, rows: 52 }, 5000); // GUI mudou
  assert.equal(g.divergent, true);
  assert.equal(g.autoRefit(5000, false), false); // sem foco: nao
  assert.equal(g.autoRefit(5000, true), true); // 1o
  assert.equal(g.autoRefit(6000, true), false); // < 3 s
  assert.equal(g.autoRefit(8100, true), true); // 2o
  assert.equal(g.autoRefit(11200, true), true); // 3o
  assert.equal(g.autoRefit(14300, true), false); // 4o em 30 s: briga
  assert.equal(g.fighting, true);
  // o botao "Reajustar" (manual) zera a contagem
  g.request(want, { cols: 228, rows: 52 }, "manual", 15000);
  assert.equal(g.fighting, false);
  g.hostSize({ cols: 228, rows: 52 }, 20000);
  assert.equal(g.autoRefit(20000, true), true);
  // passados 30 s a janela anda
  const h = new FitGovernor();
  h.request(want, { cols: 1, rows: 1 }, "open", 0);
  h.hostSize(want, 10);
  h.divergent = true;
  assert.ok(h.autoRefit(1000, true) && h.autoRefit(5000, true) && h.autoRefit(9000, true));
  assert.equal(h.autoRefit(40000, true), true);
});
