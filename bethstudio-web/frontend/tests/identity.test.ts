// Identidade visual do Beth Studio (AGENTS.md, "Product identity").
//
// Este teste trava o visual PADRÃO: as cores dos temas da interface e a
// impressão digital delas. Se ele falhou, uma mudança alterou o visual que
// todo mundo vê ao abrir o Studio. Isso não se faz por efeito colateral:
//   1. combine com o Rodrigo antes;
//   2. entregue o visual novo como OPÇÃO (tema ou preset em Configurações),
//      mantendo o atual como padrão;
//   3. só então, se o padrão mudar de propósito, atualize o valor abaixo
//      no mesmo commit e diga o motivo na mensagem.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { LIGHT, NAVY_DARK, VSCODE_DARK } from "../src/lib/uiTheme.ts";

const fingerprint = (o: unknown) => createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);

test("identidade: as cores padrão dos temas da interface não mudam sem decisão", () => {
  const got = { navy: fingerprint(NAVY_DARK), light: fingerprint(LIGHT), vscode: fingerprint(VSCODE_DARK) };
  assert.deepEqual(got, EXPECTED, "o visual padrão mudou: leia o comentário no topo deste arquivo e AGENTS.md");
});

const EXPECTED = { navy: "3d7fa0acf9036e53", light: "a04dfaa5b579d9c6", vscode: "3b48f0e121314502" };
