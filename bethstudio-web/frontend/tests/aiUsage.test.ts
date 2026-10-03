// Uso e custos de IA: filtro da tabela; selo "mais lento" dos modelos grandes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { filterUsage, type UsageRecord } from "../src/lib/aiUsage.ts";
import { badgesFor, isLarge } from "../src/lib/modelCatalog.ts";

const r = (p: Partial<UsageRecord>): UsageRecord => ({ ts: "2026-09-25T15:00:00-03:00", func: "transcricao", provider: "deepinfra", model: "m", ms: 1, ok: true, cost_usd: 0, price_source: "api", ...p });

test("filtro por função e texto (sem acento)", () => {
  const recs = [r({ model: "whisper" }), r({ func: "correcao", model: "llama", ok: false, error: "passou do prazo" }), r({ provider: "groq", test: true })];
  assert.equal(filterUsage(recs, "", "correcao").length, 1);
  assert.equal(filterUsage(recs, "PRAZO", "").length, 1);
  assert.equal(filterUsage(recs, "correção", "").length, 1);
  assert.equal(filterUsage(recs, "teste groq", "").length, 1);
  assert.equal(filterUsage(recs, "erro", "").length, 1);
});

test("modelos grandes: mais lento", () => {
  assert.ok(isLarge("meta-llama/Llama-3.3-70B-Instruct-Turbo"));
  assert.ok(isLarge("Qwen/Qwen2.5-72B-Instruct"));
  assert.ok(isLarge("meta-llama/Meta-Llama-3.1-405B-Instruct"));
  assert.ok(!isLarge("meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo"));
  assert.ok(!isLarge("mistralai/Mistral-Small-3.2-24B-Instruct-2506"));
  assert.ok(!isLarge("gpt-4.1-mini"));
  const b = badgesFor(
    [
      { id: "Qwen/Qwen2.5-72B-Instruct", name: "", func: "llm", per_min: -1, in_per_m: 0.36, out_per_m: 0.4 },
      { id: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo", name: "", func: "llm", per_min: -1, in_per_m: 0.02, out_per_m: 0.04 },
    ],
    ["meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo"],
  );
  assert.ok(b.get("Qwen/Qwen2.5-72B-Instruct")!.includes("mais lento"));
  assert.deepEqual(b.get("meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo"), ["recomendado", "rápido"]);
});
