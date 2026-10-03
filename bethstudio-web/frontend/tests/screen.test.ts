// Tela sintetica com linhas cheias e caracteres de largura divergente:
// com DECAWM off + linhas posicionadas, o xterm mostra exatamente `rows`
// linhas e a ultima continua visivel (nada quebra nem rola).
import { test } from "node:test";
import assert from "node:assert/strict";
import headless from "@xterm/headless";
import u11 from "@xterm/addon-unicode11";
import { screenWrite } from "../src/lib/screen.ts";

const { Terminal } = headless;

function render(data: string, cols: number, rows: number, ver: "6" | "11" = "11"): Promise<InstanceType<typeof Terminal>> {
  return new Promise((res) => {
    const t = new Terminal({ cols, rows, scrollback: 100, allowProposedApi: true });
    if (ver === "11") {
      t.loadAddon(new u11.Unicode11Addon());
      t.unicode.activeVersion = "11";
    }
    t.write(data, () => res(t));
  });
}

const line = (t: InstanceType<typeof Terminal>, i: number) => t.buffer.active.getLine(i)!.translateToString(true);

// 80 colunas pelo host: emojis contados como 1 pelo host (tabela antiga)
// => o xterm (Unicode 11, emoji = 2) mede 82 e, com autowrap, quebraria.
const cols = 80;
const rowsN = 5;
const wide = "ab ✳ \u{1F680}\u{1F642} " + "x".repeat(cols - 8);
const exact = "E".repeat(cols);
const text = [
  "\x1b[1;32mprimeira\x1b[0m",
  wide,
  exact,
  "\x1b[31mvermelho continua\x1b[0m",
  "ULTIMA LINHA visivel",
].join("\r\n");
const ev = { text, cursor_x: 0, cursor_y: 4, cursor_visible: true, rows: rowsN };

test("modo antigo (autowrap) quebra e empurra a ultima linha para fora", async () => {
  const t = await render("\x1b[0m\x1b[H\x1b[2J" + text, cols, rowsN);
  const b = t.buffer.active;
  const wrapped = [...Array(b.length).keys()].filter((i) => b.getLine(i)!.isWrapped).length;
  assert.ok(wrapped > 0 || b.baseY > 0, "o bug deveria aparecer no modo antigo");
  t.dispose();
});

test("DECAWM off + linhas posicionadas: rows linhas, ultima visivel, nada rolou", async () => {
  const t = await render(screenWrite(ev), cols, rowsN);
  const b = t.buffer.active;
  assert.equal(b.baseY, 0, "nao pode rolar");
  assert.equal(b.length, rowsN, "numero de linhas renderizadas = rows");
  for (let i = 0; i < b.length; i++) assert.equal(b.getLine(i)!.isWrapped, false);
  assert.equal(line(t, 0), "primeira");
  assert.equal(line(t, 2), exact, "linha com exatamente cols caracteres inteira");
  assert.equal(line(t, 3), "vermelho continua");
  assert.equal(line(t, 4), "ULTIMA LINHA visivel");
  assert.ok(line(t, 1).startsWith("ab ✳ "));
  // cor preservada na linha 3 (SGR sequencial)
  assert.equal(b.getLine(3)!.getCell(0)!.getFgColor(), 1);
  t.dispose();
});

test("mesmo com a tabela Unicode 6 continua sem quebrar", async () => {
  const t = await render(screenWrite(ev), cols, rowsN, "6");
  assert.equal(t.buffer.active.baseY, 0);
  assert.equal(line(t, 4), "ULTIMA LINHA visivel");
  t.dispose();
});

test("texto com mais linhas que rows e' cortado em rows", async () => {
  const many = { ...ev, text: Array.from({ length: 9 }, (_, i) => `L${i}`).join("\r\n") };
  const t = await render(screenWrite(many), cols, rowsN);
  assert.equal(t.buffer.active.baseY, 0);
  assert.equal(line(t, 4), "L4");
  t.dispose();
});
