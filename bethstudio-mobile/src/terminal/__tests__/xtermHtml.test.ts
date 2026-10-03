/**
 * @jest-environment node
 */
import * as fs from "fs";
import { terminalHtml } from "../xtermHtml";

describe("pagina do terminal", () => {
  const html = terminalHtml();

  it("carrega tudo inline: nenhum script/estilo/fonte de fora", () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).toMatch(/Content-Security-Policy/);
    expect(html).toMatch(/default-src 'none'/);
  });

  it("tem xterm, o addon unicode11 e a ponte window.bt", () => {
    expect(html).toContain("window.bt = {");
    expect(html).toContain("Unicode11Addon");
    expect(html.match(/<script>/g)?.length).toBe(4);
    // Nenhum </script> perdido dentro do codigo embutido.
    expect(html.match(/<\/script>/gi)?.length).toBe(4);
  });

  it("escreve a tela sem autowrap e com cada linha posicionada", () => {
    // DECAWM off: um caractere medido mais largo que no host nao quebra a linha.
    expect(html).toContain('"\\x1b[?7l\\x1b[0m\\x1b[H\\x1b[2J"');
    expect(html).toContain('"\\x1b[" + (i + 1) + ";1H" + rows[i]');
    expect(html).not.toContain('"\\x1b[0m\\x1b[H\\x1b[2J" + ev.text');
  });

  it("grava a pagina para um teste manual no navegador (BT_DUMP_HTML=arquivo)", () => {
    const out = process.env.BT_DUMP_HTML;
    if (out) fs.writeFileSync(out, html);
    expect(html.length).toBeGreaterThan(100_000);
  });
});
