// Pipeline de voz: NDJSON, streaming, prazo, cancelamento, formatacao e relatorio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { correctStreaming, correctTimeoutMs, formatUSD, markNoEnter, parseNDJSON, reportText, VoiceError } from "../src/lib/voicePipeline.ts";
import type { Connection } from "../src/lib/connection.ts";

test("NDJSON: linhas completas e resto", () => {
  const r = parseNDJSON('{"delta":"a"}\n{"delta":"b"}\n{"do');
  assert.deepEqual(r.events, [{ delta: "a" }, { delta: "b" }]);
  assert.equal(r.rest, '{"do');
  assert.deepEqual(parseNDJSON("lixo\n\n").events, []);
});

/** Conexao falsa: o corpo chega em pedacos, com atrasos. */
function fakeConn(chunks: { text: string; delay: number }[]): Connection {
  return {
    postStream: async (_p: string, _b: unknown, signal?: AbortSignal) => {
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(ctrl) {
          for (const c of chunks) {
            await new Promise<void>((res, rej) => {
              const t = setTimeout(res, c.delay);
              signal?.addEventListener("abort", () => {
                clearTimeout(t);
                rej(new DOMException("aborted", "AbortError"));
              });
            }).catch((e) => {
              ctrl.error(e);
              throw e;
            });
            ctrl.enqueue(enc.encode(c.text));
          }
          ctrl.close();
        },
      });
      return new Response(body);
    },
  } as unknown as Connection;
}

test("streaming: o texto chega aos poucos e termina com o resultado", async () => {
  const seen: string[] = [];
  const r = await correctStreaming(
    fakeConn([
      { text: '{"delta":"texto "}\n{"del', delay: 5 },
      { text: 'ta":"corrigido"}\n', delay: 5 },
      { text: '{"done":true,"text":"texto corrigido","ms":10,"ttfb_ms":3,"cost_usd":0.00001}\n', delay: 5 },
    ]),
    "x",
    { timeoutMs: 5000, onDelta: (s) => seen.push(s) },
  );
  assert.deepEqual(seen, ["texto ", "texto corrigido"]);
  assert.equal(r.text, "texto corrigido");
});

test("erro de prazo vindo do Go", async () => {
  await assert.rejects(
    correctStreaming(fakeConn([{ text: '{"error":"a correção passou do prazo de 30 s","timeout":true}\n', delay: 1 }]), "x", { timeoutMs: 5000 }),
    (e: VoiceError) => e.timeout && /prazo/.test(e.message),
  );
});

test("a UI desiste sozinha se o Go não responder (prazo + margem)", async () => {
  const t0 = Date.now();
  await assert.rejects(correctStreaming(fakeConn([{ text: "{}", delay: 60_000 }]), "x", { timeoutMs: -2900 }), (e: VoiceError) => e.timeout);
  assert.ok(Date.now() - t0 < 2000);
});

test("Pular correção / Cancelar: aborta na hora", async () => {
  const ac = new AbortController();
  const p = correctStreaming(fakeConn([{ text: '{"delta":"a"}\n', delay: 5 }, { text: "{}", delay: 60_000 }]), "x", { timeoutMs: 30_000, signal: ac.signal });
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(p, (e: VoiceError) => e.canceled && !e.timeout);
});

test("prazo padrão e formatação", () => {
  assert.equal(correctTimeoutMs(undefined), 30_000);
  assert.equal(correctTimeoutMs(0), 30_000);
  assert.equal(correctTimeoutMs(12), 12_000);
  assert.equal(formatUSD(0), "US$ 0");
  assert.equal(formatUSD(0.0000123), "US$ 0,000012");
  assert.equal(formatUSD(0.00063), "US$ 0,00063");
  assert.equal(formatUSD(0.0321), "US$ 0,0321");
  assert.equal(formatUSD(3.5), "US$ 3,50");
  assert.equal(markNoEnter("[voz]\nabre o BethTerm"), "[voz] ⏎(quebra, sem Enter)\nabre o BethTerm ⟂(fim — sem Enter)");
});

test("relatório do Testar tudo", () => {
  const t = reportText(
    [
      { title: "Microfone", status: "ok", ms: 5000, lines: ["5 s gravados"] },
      { title: "Correção", status: "erro", ms: 30000, lines: ["passou do prazo"] },
    ],
    new Date(2026, 8, 25, 15, 0, 0),
  );
  assert.match(t, /✓ 1\. Microfone \(5,0 s\)\n {4}5 s gravados/);
  assert.match(t, /✗ 2\. Correção \(30,0 s\)/);
});

test("Comparar caminhos: plano e o mais rápido", async () => {
  const { comparePlan, fastestPath } = await import("../src/lib/voicePipeline.ts");
  assert.equal(comparePlan("deepinfra").length, 8);
  assert.equal(comparePlan("groq").length, 4);
  assert.ok(comparePlan("groq").every((r) => r.route === "openai"));
  const best = fastestPath([
    { route: "openai", format: "webm", round: 1, ms: 19000 },
    { route: "openai", format: "webm", round: 2, ms: 1500 },
    { route: "native", format: "wav", round: 1, ms: 1200 },
    { route: "native", format: "wav", round: 2, ms: 1400 },
    { route: "native", format: "webm", round: 1, error: "x" },
  ]);
  assert.deepEqual(best, { route: "native", format: "wav", avgMs: 1300 });
  assert.equal(fastestPath([]), null);
});

test("transcribe: erros do Go (kind) chegam classificados na VoiceError", async () => {
  const { transcribe } = await import("../src/lib/voicePipeline.ts");
  const fakeConnUpload = (err: unknown) =>
    ({
      upload: async () => {
        throw err;
      },
    }) as unknown as import("../src/lib/connection.ts").Connection;

  const authErr = Object.assign(new Error("DeepInfra recusou a chave (inválida ou sem permissão)"), { kind: "auth" });
  await assert.rejects(transcribe(fakeConnUpload(authErr), new Blob()), (e: VoiceError) => e.kind === "auth" && !e.timeout && !e.canceled);

  const rateErr = Object.assign(new Error("DeepInfra: limite de uso atingido"), { kind: "rate_limit" });
  await assert.rejects(transcribe(fakeConnUpload(rateErr), new Blob()), (e: VoiceError) => e.kind === "rate_limit");

  const abortErr = new DOMException("aborted", "AbortError");
  await assert.rejects(transcribe(fakeConnUpload(abortErr), new Blob()), (e: VoiceError) => e.canceled && e.kind === "canceled");

  // erro sem "kind" (ex. rede local, JSON quebrado): cai em VoiceError generica
  await assert.rejects(transcribe(fakeConnUpload(new Error("HTTP 502")), new Blob()), (e: VoiceError) => e.kind === "" && !e.timeout && !e.canceled);
});

test("errorRecovery: chave invalida so' oferece configurar; senao, tenta de novo com o audio salvo", async () => {
  const { errorRecovery } = await import("../src/lib/voicePipeline.ts");
  assert.deepEqual(errorRecovery("auth", true), { retry: false, rerecord: false, authRequired: true });
  assert.deepEqual(errorRecovery("auth", false), { retry: false, rerecord: false, authRequired: true });
  assert.deepEqual(errorRecovery("rate_limit", true), { retry: true, rerecord: true, authRequired: false });
  assert.deepEqual(errorRecovery("network", true), { retry: true, rerecord: true, authRequired: false });
  assert.deepEqual(errorRecovery("other", false), { retry: false, rerecord: true, authRequired: false });
  assert.deepEqual(errorRecovery("", false), { retry: false, rerecord: true, authRequired: false });
});

test("Falar: 'Tentar novamente' reenvia o áudio já gravado (sem gravar de novo)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("src/components/SpeakDialog.tsx", "utf8");
  // retry() usa o audio guardado em lastAudio e chama process() direto,
  // sem passar por start()/getUserMedia
  const m = src.match(/const retry = \(\) => \{[\s\S]*?\n  \};/);
  assert.ok(m, "função retry não encontrada");
  const body = m![0];
  assert.match(body, /lastAudio\.current/);
  assert.match(body, /void process\(a\.blob, snap, a\.audioMs\)/);
  assert.doesNotMatch(body, /getUserMedia/);
  assert.doesNotMatch(body, /void start\(/);
  // o audio so' e' guardado quando passa por blobProblem (nunca reenviamos lixo)
  assert.match(src, /lastAudio\.current = \{ blob, audioMs \};\s*\n\s*void process\(blob, s, audioMs\);/);
  assert.match(src, /lastAudio\.current = null; \/\/ audio inutilizavel/);
  // chave invalida: sem "Tentar novamente", com link direto para Provedores de IA
  assert.match(src, /onOpenSettings\("provedores"\)/);
  assert.match(src, /recovery\.authRequired/);
});

test("errorRecovery: correção vazia (kind empty) oferece tentar de novo, como qualquer outro erro", async () => {
  const { errorRecovery } = await import("../src/lib/voicePipeline.ts");
  assert.deepEqual(errorRecovery("empty", true), { retry: true, rerecord: true, authRequired: false });
});

test("Falar: 'Corrigir novamente' reenvia o texto já transcrito (sem regravar) e nunca aceita correção vazia como sucesso", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("src/components/SpeakDialog.tsx", "utf8");
  const m = src.match(/const retryCorrection = \(\) => \{[\s\S]*?\n  \};/);
  assert.ok(m, "função retryCorrection não encontrada");
  const body = m![0];
  assert.match(body, /correctStreaming\(conn, original,/);
  assert.doesNotMatch(body, /getUserMedia/);
  assert.doesNotMatch(body, /void start\(/);
  assert.doesNotMatch(body, /void process\(/);
  // rede de segurança: mesmo um "sucesso" com texto vazio vira erro (kind "empty"), nunca some silenciosamente
  assert.match(body, /if \(!c\.text\.trim\(\)\) throw new VoiceError\("a correção voltou vazia", \{ kind: "empty" \}\);/);
  assert.match(src, /if \(!c\.text\.trim\(\)\) throw new VoiceError\("a correção voltou vazia", \{ kind: "empty" \}\);/g);
  // o botão fica ao lado de Descartar / Gravar de novo / Enviar ao terminal, so' com correção ligada
  assert.match(src, /snap\?\.settings\.llm_enabled && original\.trim\(\) && \(/);
  assert.match(src, />\s*Corrigir novamente\s*</);
});
