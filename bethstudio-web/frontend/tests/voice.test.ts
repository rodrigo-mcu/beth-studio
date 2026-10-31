import { test } from "node:test";
import assert from "node:assert/strict";
import { ambiguousSpans, composeMessage, formatDuration, micErrorMessage, sanitizePaste, wordDiff } from "../src/lib/voice.ts";

const PREFIX =
  "[Mensagem ditada por voz e transcrita automaticamente — pode conter erros de reconhecimento. Se algo parecer estranho ou ambíguo, pergunte antes de agir.]";

test("prefixo ligado: uma linha de aviso + o texto; desligado: so' o texto", () => {
  assert.equal(composeMessage(true, PREFIX, "abre o arquivo main.go"), `${PREFIX}\nabre o arquivo main.go`);
  assert.equal(composeMessage(false, PREFIX, "abre o arquivo main.go"), "abre o arquivo main.go");
  assert.equal(composeMessage(true, "   ", "x"), "x"); // prefixo vazio = sem prefixo
});

test("o texto colado nunca tem \\r nem Enter no fim", () => {
  const out = composeMessage(true, PREFIX + "\r\n", "linha 1\r\nlinha 2\r\n\r\n  ");
  assert.ok(!out.includes("\r"));
  assert.ok(!/[\n\s]$/.test(out));
  assert.equal(out, `${PREFIX}\nlinha 1\nlinha 2`);
  assert.equal(sanitizePaste("oi\n"), "oi");
  assert.equal(sanitizePaste("\n\noi"), "oi");
});

test("trechos [? ] ficam no texto (o agente ve a duvida)", () => {
  const t = "roda o [? bet term] no [? uésseele]";
  assert.equal(composeMessage(false, "", t), t);
  assert.deepEqual(ambiguousSpans(t), ["bet term", "uésseele"]);
});

test("diferenca por palavras destaca o que a correcao mudou", () => {
  const d = wordDiff("abre o bet term no power shell", "abre o BethStudio no PowerShell");
  assert.deepEqual(
    d.filter((p) => p.kind !== "same").map((p) => [p.kind, p.text.trim()]),
    [
      ["removed", "bet term"],
      ["added", "BethStudio"],
      ["removed", "power shell"],
      ["added", "PowerShell"],
    ],
  );
  assert.equal(
    d
      .filter((p) => p.kind !== "removed")
      .map((p) => p.text)
      .join(""),
    "abre o BethStudio no PowerShell",
  );
  assert.deepEqual(wordDiff("igual", "igual"), [{ text: "igual", kind: "same" }]);
});

test("tempo e mensagens de microfone", () => {
  assert.equal(formatDuration(65_400), "1:05");
  assert.match(micErrorMessage("NotAllowedError"), /Privacidade/);
  assert.match(micErrorMessage("NotFoundError"), /Nenhum microfone/);
});

test("texto longo vai para arquivo: só acima do limite", async () => {
  const { LONG_PASTE_CHARS, isLongPaste } = await import("../src/lib/voice.ts");
  assert.equal(isLongPaste("x".repeat(LONG_PASTE_CHARS)), false);
  assert.equal(isLongPaste("x".repeat(LONG_PASTE_CHARS + 1)), true);
});
