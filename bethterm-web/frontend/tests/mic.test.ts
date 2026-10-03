// Microfone (escolha, formato, nivel, silencio) e seletor de modelos (precos, selos, busca).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SilenceWatch, audioConstraints, audioInputs, blobProblem, pickMimeType, resolveMic, rmsLevel, testVerdict } from "../src/lib/mic.ts";
import { badgesFor, contextLabel, filterModels, priceLine, sourceLine, usd, type ModelCard } from "../src/lib/modelCatalog.ts";

const devs = [
  { deviceId: "default", label: "Padrão - Microfone (Realtek High Definition Audio)", kind: "audioinput" },
  { deviceId: "communications", label: "Comunicações - Microfone (USB2.0 MIC)", kind: "audioinput" },
  { deviceId: "aaa", label: "Microfone (Realtek High Definition Audio)", kind: "audioinput" },
  { deviceId: "bbb", label: "Microfone (USB2.0 MIC)", kind: "audioinput" },
  { deviceId: "ccc", label: "Alto-falantes", kind: "audiooutput" },
];

test("entradas reais, sem default/communications nem saídas", () => {
  assert.deepEqual(
    audioInputs(devs).map((d) => d.deviceId),
    ["aaa", "bbb"],
  );
});

test("reencontra o microfone salvo por id, depois por nome", () => {
  assert.deepEqual(resolveMic(devs, { id: "bbb", label: "x" }), { deviceId: "bbb", label: "Microfone (USB2.0 MIC)", found: true });
  assert.deepEqual(resolveMic(devs, { id: "mudou", label: "Microfone (USB2.0 MIC)" }), { deviceId: "bbb", label: "Microfone (USB2.0 MIC)", found: true });
  assert.equal(resolveMic(devs, { id: "sumiu", label: "Microfone (REDRAGON)" }).found, false);
  assert.deepEqual(resolveMic(devs, { id: "", label: "" }), { deviceId: "", label: "", found: true });
});

test("constraints: deviceId exato só quando escolhido", () => {
  assert.equal(audioConstraints("").deviceId, undefined);
  assert.deepEqual(audioConstraints("bbb").deviceId, { exact: "bbb" });
});

test("formato: opus em webm primeiro, com fallback", () => {
  assert.equal(
    pickMimeType(() => true),
    "audio/webm;codecs=opus",
  );
  assert.equal(
    pickMimeType((m) => m === "audio/ogg;codecs=opus"),
    "audio/ogg;codecs=opus",
  );
  assert.equal(
    pickMimeType(() => false),
    "",
  );
  assert.equal(
    pickMimeType(() => {
      throw new Error("x");
    }),
    "",
  );
});

test("nível e silêncio de 3 s", () => {
  assert.equal(rmsLevel(new Uint8Array(64).fill(128)), 0);
  assert.ok(rmsLevel(Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 160 : 96))) > 0.5);
  const w = new SilenceWatch();
  assert.equal(w.feed(0, 0), false);
  assert.equal(w.feed(0.001, 2900), false);
  assert.equal(w.feed(0.001, 3000), true);
  assert.equal(w.feed(0.3, 3100), false); // falou: zera
  assert.equal(w.feed(0, 3200), false);
});

test("veredito do teste e blob vazio", () => {
  assert.equal(testVerdict(0).ok, false);
  assert.match(testVerdict(0.3).text, /Sinal ok/);
  assert.match(testVerdict(0.03).text, /fraco/);
  assert.match(blobProblem(0, 0)!, /não entregou/);
  assert.match(blobProblem(0, 3)!, /vazio/);
  assert.match(blobProblem(50, 1)!, /pequeno/);
  assert.equal(blobProblem(20000, 5), null);
});

const cards: ModelCard[] = [
  { id: "openai/whisper-large-v3-turbo", name: "Whisper Large V3 Turbo", func: "stt", per_min: 0.0002, in_per_m: -1, out_per_m: -1 },
  { id: "openai/whisper-large-v3", name: "Whisper Large V3", func: "stt", per_min: 0.00045, in_per_m: -1, out_per_m: -1 },
  { id: "mistralai/Voxtral-Small-24B-2507", name: "Voxtral Small 24B 2507", func: "stt", per_min: 0.003, in_per_m: -1, out_per_m: -1 },
  { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", name: "Llama 3.3 70B Instruct Turbo", func: "llm", per_min: -1, in_per_m: 0.1, out_per_m: 0.32, context: 131072 },
  { id: "Qwen/Qwen2.5-72B-Instruct", name: "Qwen2.5 72B Instruct", func: "llm", per_min: -1, in_per_m: 0.36, out_per_m: 0.4, context: 32768 },
  { id: "big/Model-405B", name: "Model 405B", func: "llm", per_min: -1, in_per_m: 3, out_per_m: 3 },
  { id: "x/sem-preco", name: "Sem Preço", func: "llm", per_min: -1, in_per_m: -1, out_per_m: -1 },
];

test("preços e rótulos", () => {
  assert.equal(usd(-1), "—");
  assert.equal(usd(0), "grátis");
  assert.equal(usd(0.0002), "US$ 0,0002");
  assert.equal(usd(0.32), "US$ 0,32");
  assert.equal(priceLine(cards[0]), "US$ 0,0002 / min de áudio · US$ 0,01 / hora");
  assert.equal(priceLine(cards[3]), "US$ 0,10 entrada · US$ 0,32 saída / 1M tokens");
  assert.equal(priceLine(cards[6]), "preço: ver site");
  assert.equal(contextLabel(131072), "131k tokens");
  assert.equal(contextLabel(1048576), "1,0M tokens");
  assert.match(sourceLine({ provider: "groq", source: "reference", as_of: "2026-06", models: [] }), /referência de 06\/2026/);
});

test("selos: recomendado, rápido e barato por função", () => {
  const b = badgesFor(cards, ["openai/whisper-large-v3-turbo", "meta-llama/Llama-3.3-70B-Instruct-Turbo"]);
  assert.deepEqual(b.get("openai/whisper-large-v3-turbo"), ["recomendado", "rápido", "barato"]);
  assert.deepEqual(b.get("mistralai/Voxtral-Small-24B-2507"), ["rápido"]); // small, caro
  assert.ok(b.get("meta-llama/Llama-3.3-70B-Instruct-Turbo")!.includes("barato"));
  assert.deepEqual(b.get("big/Model-405B"), ["mais lento"]);
  assert.deepEqual(b.get("x/sem-preco"), []);
});

test("busca sem acento, filtro por função e ordem", () => {
  const rec = ["meta-llama/Llama-3.3-70B-Instruct-Turbo"];
  assert.deepEqual(
    filterModels(cards, "", "llm", rec).map((m) => m.id),
    ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-72B-Instruct", "big/Model-405B", "x/sem-preco"],
  );
  assert.deepEqual(
    filterModels(cards, "WHISPER v3", "all", []).map((m) => m.id),
    ["openai/whisper-large-v3-turbo", "openai/whisper-large-v3"],
  );
  assert.deepEqual(
    filterModels(cards, "preço", "llm", []).map((m) => m.id),
    ["x/sem-preco"],
  );
});

test("Falar: a gravação começa uma vez só (o efeito não depende dos callbacks do App)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("src/components/SpeakDialog.tsx", "utf8");
  const i = src.indexOf("loadVoice(conn)");
  assert.ok(i > 0);
  const deps = src.slice(i).match(/\n {2}\}, \[([^\]]*)\]\);/);
  assert.equal(deps?.[1], "conn");
  // um getUserMedia por gravação, protegido contra repetição
  assert.match(src, /if \(busy\.current \|\| closed\.current\)/);
  assert.equal((src.match(/getUserMedia\(/g) ?? []).length, 1);
});

test("Falar: por padrão a correção não aparece chegando (só com a opção ligada)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("src/components/SpeakDialog.tsx", "utf8");
  assert.match(src, /onDelta: s\.settings\.show_correction_stream \? setStreamText : undefined/);
});
