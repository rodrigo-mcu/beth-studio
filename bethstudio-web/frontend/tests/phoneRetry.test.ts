import { test } from "node:test";
import assert from "node:assert/strict";
import { isRetryable, retryDelayMs, runWithRetry, socketIsStale, offlineVerdict } from "../src/phone/retry.ts";

test("retryDelayMs: cresce e para em 30 s", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(retryDelayMs), [2000, 4000, 8000, 15000, 30000, 30000, 30000]);
});

test("isRetryable: rede e 5xx tentam de novo; chave, cancelamento e fala vazia não", () => {
  assert.equal(isRetryable(new TypeError("Failed to fetch")), true);
  assert.equal(isRetryable(Object.assign(new Error("HTTP 503"), { kind: "" })), true);
  assert.equal(isRetryable(Object.assign(new Error("x"), { kind: "network" })), true);
  assert.equal(isRetryable(Object.assign(new Error("x"), { kind: "timeout" })), true);
  assert.equal(isRetryable(Object.assign(new Error("x"), { kind: "rate_limit" })), true);
  assert.equal(isRetryable(Object.assign(new Error("x"), { kind: "auth" })), false);
  assert.equal(isRetryable(Object.assign(new Error("x"), { kind: "canceled" })), false);
  assert.equal(isRetryable(Object.assign(new Error("x"), { kind: "empty" })), false);
  assert.equal(isRetryable(Object.assign(new Error("Senha"), { kind: "" })), false);
});

test("runWithRetry: falha de rede duas vezes e depois funciona, sem perder o áudio", async () => {
  let calls = 0;
  const waits: number[] = [];
  const out = await runWithRetry(
    async () => {
      calls++;
      if (calls < 3) throw new TypeError("Failed to fetch");
      return "ok";
    },
    { sleep: async (ms) => void waits.push(ms), onWait: () => undefined },
  );
  assert.equal(out, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 4000]);
});

test("runWithRetry: desiste depois do limite e devolve o último erro", async () => {
  let calls = 0;
  await assert.rejects(
    runWithRetry(
      async () => {
        calls++;
        throw new TypeError("Failed to fetch");
      },
      { sleep: async () => undefined, onWait: () => undefined, maxAttempts: 4 },
    ),
    /Failed to fetch/,
  );
  assert.equal(calls, 4);
});

test("runWithRetry: erro que não adianta repetir sai na hora", async () => {
  let calls = 0;
  await assert.rejects(
    runWithRetry(
      async () => {
        calls++;
        throw Object.assign(new Error("chave"), { kind: "auth" });
      },
      { sleep: async () => undefined, onWait: () => undefined },
    ),
    /chave/,
  );
  assert.equal(calls, 1);
});

test("runWithRetry: cancelar interrompe a espera", async () => {
  const ac = new AbortController();
  let calls = 0;
  const p = runWithRetry(
    async () => {
      calls++;
      throw new TypeError("Failed to fetch");
    },
    {
      signal: ac.signal,
      sleep: async () => {
        ac.abort();
      },
      onWait: () => undefined,
    },
  );
  await assert.rejects(p, (e: Error) => e.name === "AbortError");
  assert.equal(calls, 1);
});

test("socketIsStale: só vale se a sonda ficou sem resposta além da tolerância", () => {
  assert.equal(socketIsStale({ probeAt: 1000, lastRx: 500, now: 5000, graceMs: 8000 }), false); // ainda dentro do prazo
  assert.equal(socketIsStale({ probeAt: 1000, lastRx: 500, now: 9500, graceMs: 8000 }), true); // nada chegou depois da sonda
  assert.equal(socketIsStale({ probeAt: 1000, lastRx: 1200, now: 9500, graceMs: 8000 }), false); // respondeu
  assert.equal(socketIsStale({ probeAt: 0, lastRx: 0, now: 9500, graceMs: 8000 }), false); // sem sonda pendente
});

test("offlineVerdict: só avisa 'PC desconectado' depois de várias checagens seguidas", () => {
  assert.equal(offlineVerdict(1), false);
  assert.equal(offlineVerdict(2), false);
  assert.equal(offlineVerdict(3), true);
  assert.equal(offlineVerdict(0), false);
});
