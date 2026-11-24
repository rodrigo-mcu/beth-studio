import { test } from "node:test";
import assert from "node:assert/strict";
import { setTabFilesOpen, type Layout } from "../src/lib/layout.ts";
import { glassCoversGutter, parseGlassLine, toggleFolderPanel } from "../src/lib/sidebarFrame.ts";

function layout(): Layout {
  return {
    active: "a",
    tabs: [
      { id: "a", name: "A", root: { type: "leaf", pane: 1 } },
      { id: "b", name: "B", root: { type: "leaf", pane: 2 } },
    ],
    closed: [],
  };
}

test("setTabFilesOpen abre só a guia pedida e fecha de novo", () => {
  const open = setTabFilesOpen(layout(), "a", true);
  assert.equal(open.tabs[0].files_open, true);
  assert.equal(open.tabs[1].files_open, undefined);
  const other = setTabFilesOpen(open, "b", true);
  assert.equal(other.tabs[0].files_open, true);
  assert.equal(other.tabs[1].files_open, true);
  const closed = setTabFilesOpen(other, "a", false);
  assert.equal(closed.tabs[0].files_open, undefined);
  assert.equal(closed.tabs[1].files_open, true);
  const flipped = toggleFolderPanel({}, "a", false);
  assert.equal(flipped.mount, true);
  assert.equal(flipped.next.a, true);
  const shut = toggleFolderPanel(flipped.next, "a", true);
  assert.equal(shut.mount, false);
  assert.equal(shut.next.a, false);
});

test("o vidro que cobre o vão não passa", () => {
  const off = parseGlassLine("glass x -8 y -8 w 0 h 0 windowH 900");
  assert.ok(off);
  assert.equal(glassCoversGutter(off, 288), false);
  const card = parseGlassLine("glass x 8 y 8 w 272 h 844 windowH 900");
  assert.ok(card);
  assert.equal(glassCoversGutter(card, 288), false);
  const edge = parseGlassLine("glass x 0 y 8 w 296 h 844 windowH 900");
  assert.ok(edge);
  assert.equal(glassCoversGutter(edge, 288), true);
});
