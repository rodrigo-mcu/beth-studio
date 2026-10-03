// Link http(s): sempre no navegador padrão do sistema, nunca dentro da
// janela do app (lib/links.ts + POST /api/open-link no Go).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isHttpUrl, openExternal } from "../src/lib/links.ts";

test("isHttpUrl: só http/https com host", () => {
  assert.ok(isHttpUrl("https://example.com"));
  assert.ok(isHttpUrl("http://example.com/x?y=1"));
  assert.ok(isHttpUrl("https://portal.example.com"));
  assert.ok(isHttpUrl("https://partners.example.org/register"));
  assert.ok(!isHttpUrl("ftp://example.com"));
  assert.ok(!isHttpUrl("javascript:alert(1)"));
  assert.ok(!isHttpUrl("file:///C:/x.md"));
  assert.ok(!isHttpUrl("data:text/html,<script>"));
  assert.ok(!isHttpUrl("não é uma url"));
  assert.ok(!isHttpUrl(""));
});

test("openExternal: chama POST /api/open-link só para http(s)", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const fakeConn = { api: async (path: string, body: unknown) => (calls.push({ path, body }), { url: String((body as { url: string }).url) }) };
  await openExternal(fakeConn as never, "https://example.com/x");
  assert.deepEqual(calls, [{ path: "/api/open-link", body: { url: "https://example.com/x" } }]);

  calls.length = 0;
  await openExternal(fakeConn as never, "javascript:alert(1)");
  assert.deepEqual(calls, []); // esquema não-http nunca chega a chamar o Go
});

// Sem DOM disponível neste ambiente de teste (node --test puro, sem jsdom),
// então o roteamento de clique/auxclick/window.open é conferido lendo o
// código-fonte, seguindo a mesma convenção usada em termFocus.test.ts.
test("installLinkGuard: intercepta clique, ctrl+clique, botão do meio e window.open, tudo em fase de captura", () => {
  const src = fs.readFileSync("src/lib/links.ts", "utf8");
  assert.match(src, /addEventListener\(\s*"click"/);
  assert.match(src, /addEventListener\(\s*"auxclick"/);
  assert.match(src, /,\s*true,?\s*\)/); // fase de captura nos listeners
  assert.match(src, /ev\.button !== 1/); // botão do meio no auxclick
  assert.match(src, /preventDefault\(\)/);
  assert.match(src, /stopPropagation\(\)/);
  assert.match(src, /closest\("a\[href\]"\)/); // Ctrl+clique e clique normal: mesmo <a>, o navegador decide o modificador
  assert.match(src, /w\.open = /); // window.open interceptado
  assert.match(src, /openExternal\(conn, raw\)/);
});

test("installLinkGuard: só existe UM caminho para abrir link externo (openExternal -> /api/open-link)", () => {
  const src = fs.readFileSync("src/lib/links.ts", "utf8");
  const matches = src.match(/conn\.api[<(]/g) ?? [];
  assert.equal(matches.length, 1, "openExternal deve ser o único ponto que chama a API para abrir link");
});
