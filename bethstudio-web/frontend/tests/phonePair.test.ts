import { test } from "node:test";
import assert from "node:assert/strict";
import { clearPairFragment, exchangePair, hasPairFragment, parsePairFragment } from "../src/phone/pair.ts";

const TOK = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";

test("parsePairFragment: lê o token de #pair=", () => {
  assert.equal(parsePairFragment(`#pair=${TOK}`), TOK);
  assert.equal(parsePairFragment(`pair=${TOK}`), TOK);
  assert.equal(parsePairFragment(`#x=1&pair=${TOK}`), TOK);
});

test("parsePairFragment: rejeita ausente, curto, longo e caracteres estranhos", () => {
  assert.equal(parsePairFragment(""), null);
  assert.equal(parsePairFragment("#"), null);
  assert.equal(parsePairFragment("#pair="), null);
  assert.equal(parsePairFragment("#pair=curto"), null);
  assert.equal(parsePairFragment(`#pair=${"a".repeat(201)}`), null);
  assert.equal(parsePairFragment(`#pair=${TOK}<script>`), null);
  assert.equal(parsePairFragment(`#paired=${TOK}`), null);
  assert.equal(parsePairFragment(`#token=${TOK}`), null);
});

test("hasPairFragment: sabe que veio de link mágico mesmo com token ruim", () => {
  assert.equal(hasPairFragment("#pair=lixo"), true);
  assert.equal(hasPairFragment("#pair"), true);
  assert.equal(hasPairFragment(""), false);
  assert.equal(hasPairFragment("#outra=coisa"), false);
});

test("exchangePair: manda o token em POST JSON, não na URL", async () => {
  let seen: { url: string; init?: RequestInit } | null = null;
  const fake = (async (url: string, init?: RequestInit) => {
    seen = { url, init };
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const r = await exchangePair(TOK, fake);
  assert.deepEqual(r, { ok: true });
  assert.equal(seen!.url, "/api/phone/pair");
  assert.equal(seen!.init?.method, "POST");
  assert.equal(JSON.parse(String(seen!.init?.body)).token, TOK);
  assert.ok(!seen!.url.includes(TOK));
});

test("exchangePair: mensagens de erro em pt-BR", async () => {
  const mk = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  assert.deepEqual(await exchangePair(TOK, mk(401, { error: "link inválido ou expirado" })), { ok: false, error: "link inválido ou expirado" });
  assert.deepEqual(await exchangePair(TOK, mk(401, {})), { ok: false, error: "Link inválido ou expirado." });
  assert.deepEqual(await exchangePair(TOK, mk(503, {})), { ok: false, error: "O computador está desconectado do servidor." });
  assert.deepEqual(await exchangePair(TOK, mk(429, {})), { ok: false, error: "Muitas tentativas. Espere um minuto." });
  const boom = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
  assert.deepEqual(await exchangePair(TOK, boom), { ok: false, error: "Sem internet ou o servidor não respondeu." });
});

test("clearPairFragment: troca a URL sem o fragmento", () => {
  let called: unknown[] = [];
  clearPairFragment({ pathname: "/", search: "?a=1" }, { replaceState: (...a: unknown[]) => void (called = a) });
  assert.deepEqual(called, [null, "", "/?a=1"]);
  assert.doesNotThrow(() =>
    clearPairFragment({ pathname: "/", search: "" }, {
      replaceState: () => {
        throw new Error("sem histórico");
      },
    }),
  );
});
