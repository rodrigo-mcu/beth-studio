// Vocabulario tecnico: busca na lista (a montagem do prompt e o corte ficam no Go: techvocab_test.go).
import { test } from "node:test";
import assert from "node:assert/strict";
import { filterVocab } from "../src/lib/techVocab.ts";

test("busca sem acento, categorias vazias somem", () => {
  const cats = [
    { name: "Linguagens", terms: ["C#", "C++", "TypeScript"] },
    { name: "SO", terms: ["Windows", "Gerenciador de Tarefas"] },
  ];
  assert.deepEqual(filterVocab(cats, ""), cats);
  assert.deepEqual(filterVocab(cats, "c#"), [{ name: "Linguagens", terms: ["C#"] }]);
  assert.deepEqual(filterVocab(cats, "GERENCIADOR"), [{ name: "SO", terms: ["Gerenciador de Tarefas"] }]);
  assert.deepEqual(filterVocab(cats, "tarefás"), [{ name: "SO", terms: ["Gerenciador de Tarefas"] }]);
  assert.deepEqual(filterVocab(cats, "zzz"), []);
});
