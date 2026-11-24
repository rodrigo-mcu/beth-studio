import { test } from "node:test";
import assert from "node:assert/strict";
import { framesMatch, glassCoversGutter, parseGlassLine, sideFrame, toggleFolderPanel, vibrancyCardRect } from "../src/lib/sidebarFrame.ts";
import { setTabFilesOpen, type Layout } from "../src/lib/layout.ts";

test("a faixa começa abaixo das abas e acaba 8 px acima do fundo", () => {
  const f = sideFrame(900, "rgb(19, 19, 19)");
  assert.equal(f.top, 48);
  assert.equal(f.bottom, 892);
  assert.equal(f.height, 844);
  assert.equal(f.gutter, "rgb(19, 19, 19)");
});

test("o aviso conta como parte da altura do terminal", () => {
  const plain = sideFrame(900, "rgb(19, 19, 19)");
  const withBanner = sideFrame(900, "rgb(19, 19, 19)", 40, 8, 36);
  assert.equal(withBanner.top, plain.top);
  assert.equal(withBanner.bottom, plain.bottom);
  assert.equal(withBanner.height, plain.height - 36);
});

test("o vidro no vão da coluna faz o teste falhar", () => {
  const off = parseGlassLine("glass x -8 y -8 w 0 h 0 windowH 900 gutter color");
  assert.ok(off);
  assert.equal(glassCoversGutter(off, 288), false);
  assert.equal(off.w, 0);
  const card = vibrancyCardRect(true, 900, 288);
  assert.equal(card.x, 8);
  assert.equal(card.w, 272);
  assert.equal(card.h, 844);
  assert.equal(glassCoversGutter(card, 288), false);
  const logged = parseGlassLine("glass x 8 y 8 w 272 h 844 windowH 900");
  assert.ok(logged);
  assert.equal(glassCoversGutter(logged, 288), false);
  const atEdge = parseGlassLine("glass x 0 y 8 w 296 h 844 windowH 900");
  assert.ok(atEdge);
  assert.equal(glassCoversGutter(atEdge, 288), true);
  assert.equal(vibrancyCardRect(false, 900, 288).w, 0);
  assert.equal(parseGlassLine("measured top 48 bottomInset 8 height 844 width 288 gutter topbar on 0"), null);
  assert.equal(parseGlassLine("measured top 48 bottomInset 8 height 844 width 288 gutter topbar on 1"), null);
});

test("esquerda e direita usam a mesma faixa e a mesma cor da topbar", () => {
  const left = sideFrame(900, "rgb(19, 19, 19)");
  const right = sideFrame(900, "rgb(19, 19, 19)");
  assert.equal(framesMatch(left, right), true);
  assert.equal(left.gutter, right.gutter);
});

function layout(): Layout {
  return {
    active: "a",
    tabs: [{ id: "a", name: "A", root: { type: "leaf", pane: 1 } }],
    closed: [],
  };
}

test("setTabFilesOpen abre a pasta da guia e o painel monta só nessa guia", () => {
  const open = setTabFilesOpen(layout(), "a", true);
  assert.equal(open.tabs[0].files_open, true);
  const closed = setTabFilesOpen(open, "a", false);
  assert.equal(closed.tabs[0].files_open, undefined);
  const flipped = toggleFolderPanel({}, "a", false);
  assert.equal(flipped.open, true);
  assert.equal(flipped.mount, true);
  assert.equal(flipped.next.a, true);
  const shut = toggleFolderPanel(flipped.next, "a", true);
  assert.equal(shut.mount, false);
});
