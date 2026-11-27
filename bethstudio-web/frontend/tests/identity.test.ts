// Este teste protege o visual padrão do Beth Studio (as cores dos temas da
// interface), que é o que todo mundo vê ao abrir o Studio.
//
// Se ele falhou, sua mudança mexeu nesse padrão. Tudo bem ter ideias de
// visual novo: ofereça como opção (tema, preset ou escolha em
// Configurações), mantendo o atual como padrão. Se combinamos mudar o
// padrão, atualize o valor de EXPECTED no mesmo commit e diga o motivo.
// Guia: CONTRIBUTING.md, seção "Working together".
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { LIGHT, NAVY_DARK, VSCODE_DARK } from "../src/lib/uiTheme.ts";

const fingerprint = (o: unknown) => createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);

test("visual padrão: cores dos temas da interface", () => {
  const got = { navy: fingerprint(NAVY_DARK), light: fingerprint(LIGHT), vscode: fingerprint(VSCODE_DARK) };
  assert.deepEqual(got, EXPECTED, "as cores padrão mudaram; veja o comentário no topo deste arquivo (visual novo entra como opção)");
});

const EXPECTED = { navy: "3d7fa0acf9036e53", light: "a04dfaa5b579d9c6", vscode: "3b48f0e121314502" };
