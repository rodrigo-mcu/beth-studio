import { test } from "node:test";
import assert from "node:assert/strict";
import { nextScrollOffset, orderPhonePanes, phonePaste, plainScreen } from "../src/lib/phoneScreen.ts";
import type { PaneInfo } from "../src/lib/types.ts";
import type { AgentState } from "../src/lib/agents.ts";

function pane(id: number, title: string): PaneInfo {
  return {
    pane_id: id,
    title,
    cwd: "",
    size: { cols: 80, rows: 24 },
    window_id: 1,
    tab_id: 1,
    is_active: false,
    is_zoomed: false,
  };
}

test("plainScreen tira cor e espaço no fim da linha", () => {
  const raw = "\x1b[32mola\x1b[0m   \r\n\x1b[1magente\x1b[0m\r\n   \r\n";
  assert.equal(plainScreen(raw), "ola\nagente");
});

test("lista: quem espera vem primeiro, o mais antigo no topo", () => {
  const panes = [pane(2, "zeta"), pane(1, "alfa"), pane(3, "meio")];
  const agents: AgentState = {
    3: { pane: 3, reason: "bell", detail: "", since: 200 },
    1: { pane: 1, reason: "toast", detail: "", since: 100 },
  };
  const ids = orderPhonePanes(panes, agents, (p) => p.title).map((p) => p.pane_id);
  assert.deepEqual(ids, [1, 3, 2]);
});

test("o mesmo terminal não aparece duas vezes", () => {
  const panes = [pane(7, "agente"), pane(7, "agente de novo"), pane(8, "outro")];
  const ids = orderPhonePanes(panes, {}, (p) => p.title).map((p) => p.pane_id);
  assert.deepEqual(ids, [7, 8]);
});

test("Enviar cola o texto sem Enter dentro dele", () => {
  assert.equal(phonePaste("  olá\n"), "  olá");
  assert.equal(phonePaste("   \n"), null);
  assert.equal(phonePaste("linha\r\n"), "linha");
});

test("rolar: sobe no histórico e para no vivo", () => {
  assert.equal(nextScrollOffset(0, 10, 100), 10);
  assert.equal(nextScrollOffset(10, -30, 100), 0);
  assert.equal(nextScrollOffset(90, 50, 100), 100);
  assert.equal(nextScrollOffset(0, 5, 0), 0);
});
