import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { MENU_ROW_SELECTOR, clickDrawnMenuRow, menuRowsFromNodes, menuSymbol, pageMenuHidden, pageMenuStyle, readMenuNode } from "../src/lib/glassMenu.ts";

// MenuItem publica o rótulo em span.min-w-0.flex-1.truncate e o símbolo em
// data-symbol. O clique do host é clickDrawnMenuRow, a mesma função que
// GlassMenu.__bethMenuClick chama, sobre querySelectorAll(MENU_ROW_SELECTOR).

const window = new Window();
const document = window.document;

function menuItem(label: string, opts: { symbol?: string; danger?: boolean } = {}): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  const symbol = menuSymbol(opts.symbol);
  if (symbol) button.setAttribute("data-symbol", symbol);
  button.className = [
    "flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-bg-hover",
    opts.danger ? "text-status-err hover:bg-status-err/10" : "text-text-1",
  ].join(" ");
  const span = document.createElement("span");
  span.className = "min-w-0 flex-1 truncate";
  span.textContent = label;
  button.appendChild(span);
  return button;
}

function hintItem(label: string, hint: string, symbol?: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  const mapped = menuSymbol(symbol);
  if (mapped) button.setAttribute("data-symbol", mapped);
  button.className = "flex w-full items-center gap-2 px-3 py-1.5 text-left text-text-1";
  const icon = document.createElement("span");
  icon.className = "w-4 shrink-0";
  if (mapped) icon.setAttribute("data-symbol", mapped);
  const wrap = document.createElement("span");
  wrap.className = "min-w-0 flex-1";
  const name = document.createElement("span");
  name.className = "block truncate";
  name.textContent = label;
  const sub = document.createElement("span");
  sub.className = "block truncate text-[11px] text-text-3";
  sub.textContent = hint;
  wrap.append(name, sub);
  button.append(icon, wrap);
  return button;
}

function rule(): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "bt-menu-rule my-1 border-t border-border";
  return div;
}

function mount(children: Node[]): HTMLDivElement {
  const root = document.createElement("div");
  root.className = "bt-menu";
  root.append(...children);
  document.body.replaceChildren(root);
  return root;
}

function buttons(root: ParentNode): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll("button"));
}

function payload(root: ParentNode) {
  const nodes = Array.from(root.querySelectorAll(MENU_ROW_SELECTOR)).map((el) => readMenuNode(el));
  return menuRowsFromNodes(nodes);
}

test("querySelectorAll button, .bt-menu-rule: a divisória não clica e o item seguinte acerta o botão", () => {
  const root = mount([
    menuItem("Renomear…", { symbol: "pencil" }),
    menuItem("Fechar aba", { symbol: "x" }),
    rule(),
    menuItem("Reiniciar este terminal…", { symbol: "rotate-cw" }),
    menuItem("Matar terminal…", { symbol: "power", danger: true }),
  ]);
  const drawn = Array.from(root.querySelectorAll("button, .bt-menu-rule"));
  assert.equal(MENU_ROW_SELECTOR, "button, .bt-menu-rule");
  assert.equal(drawn.length, 5);
  assert.equal(drawn.filter((el) => el.tagName === "BUTTON").length, 4);
  assert.equal(drawn[2].classList.contains("bt-menu-rule"), true);
  const walked = drawn.map((el) => readMenuNode(el));
  const rows = menuRowsFromNodes(walked).rows;
  assert.equal(rows[0].t, "Renomear…");
  assert.equal(rows[0].i, "pencil");
  assert.equal(walked[0].labelText, root.querySelector("span.min-w-0.flex-1.truncate")?.textContent);
  assert.equal(rows[2].t, "");
  // Posição 2 é a divisória desenhada. O clique do host não devolve botão.
  assert.equal(clickDrawnMenuRow(root, 2), undefined);
  const after = clickDrawnMenuRow(root, 3);
  assert.equal(after, 2);
  const clicked = root.querySelectorAll("button")[after!];
  assert.equal(clicked.querySelector(":scope > span.min-w-0.flex-1.truncate")?.textContent, "Reiniciar este terminal…");
  const kill = clickDrawnMenuRow(root, 4);
  assert.equal(kill, 3);
  assert.equal(root.querySelectorAll("button")[kill!].querySelector("span.min-w-0.flex-1.truncate")?.textContent, "Matar terminal…");
  assert.equal(rows[4].d, 1);
  assert.equal(rows[4].i, "power");
  assert.equal(rows[1].i, "xmark");
});

test("organizar: a dica não entra no rótulo e o separador não desloca o clique", () => {
  const root = mount([
    hintItem("Mover para aba…", "continua rodando", "folder-input"),
    hintItem('Tirar de "Trabalho"', "continua rodando, em Não organizados", "log-out"),
    rule(),
    menuItem("Encerrar terminal…", { symbol: "power", danger: true }),
  ]);
  const rows = payload(root).rows;
  assert.equal(rows[0].t, "Mover para aba…");
  assert.equal(rows[0].i, "folder");
  assert.equal(rows[1].t, 'Tirar de "Trabalho"');
  assert.equal(clickDrawnMenuRow(root, 2), undefined);
  const kill = clickDrawnMenuRow(root, 3);
  assert.equal(kill, 2);
  assert.equal(buttons(root)[kill!].querySelector(":scope > span.min-w-0")?.textContent, "Encerrar terminal…");
  assert.equal(clickDrawnMenuRow(root, 1), 1);
});

test("a regra transparente do menu só existe sob html.bt-vibrancy.bt-native-menu", () => {
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  assert.equal(/html\.bt-vibrancy \.bt-menu\b/.test(css), false);
  const blocks = css.split("}").map((part) => part.trim()).filter(Boolean);
  const transparent = blocks.filter((block) => /\.bt-menu\b/.test(block) && /transparent|box-shadow:\s*none/.test(block));
  assert.ok(transparent.length > 0);
  for (const block of transparent) {
    const selector = block.slice(0, block.lastIndexOf("{"));
    assert.match(selector, /html\.bt-vibrancy\.bt-native-menu/);
    assert.equal(/html\.bt-vibrancy(?!\.bt-native-menu)/.test(selector), false);
  }
});

test("o menu da página só some quando o host bethMenu está presente", () => {
  assert.equal(pageMenuHidden(true, false), false);
  assert.deepEqual(pageMenuStyle(true, false), {});
  assert.equal(pageMenuHidden(false, false), false);
  assert.equal(pageMenuHidden(false, true), false);
  assert.equal(pageMenuHidden(true, true), true);
  assert.equal(pageMenuStyle(true, true).visibility, "hidden");
});

test("pré-visualização e o primeiro item de um submenu usam o índice da linha desenhada", () => {
  const file = mount([
    menuItem("Copiar", { symbol: "copy" }),
    menuItem("Selecionar tudo", { symbol: "text-select" }),
    menuItem("Copiar caminho", { symbol: "link" }),
    menuItem("Salvar uma cópia como…", { symbol: "save" }),
  ]);
  const rows = payload(file).rows;
  assert.deepEqual(rows.map((r) => r.t), ["Copiar", "Selecionar tudo", "Copiar caminho", "Salvar uma cópia como…"]);
  assert.equal(clickDrawnMenuRow(file, 0), 0);
  assert.equal(rows[0].i, "doc.on.doc");
  assert.equal(buttons(file)[0].querySelector("span.min-w-0.flex-1.truncate")?.textContent, "Copiar");

  const sub = mount([
    menuItem("Mover para aba", { symbol: "arrow-left" }),
    hintItem("Trabalho", "está aqui"),
    rule(),
    menuItem("Nova aba", { symbol: "plus" }),
  ]);
  const subRows = payload(sub).rows;
  assert.equal(subRows[0].t, "Mover para aba");
  assert.equal(subRows[0].i, "chevron.left");
  assert.equal(clickDrawnMenuRow(sub, 0), 0);
  assert.equal(buttons(sub)[0].querySelector("span.min-w-0.flex-1.truncate")?.textContent, "Mover para aba");
  assert.equal(clickDrawnMenuRow(sub, 2), undefined);
  assert.equal(clickDrawnMenuRow(sub, 3), 2);
  assert.equal(buttons(sub)[2].textContent, "Nova aba");
});
