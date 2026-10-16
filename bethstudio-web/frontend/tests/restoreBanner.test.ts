import { test } from "node:test";
import assert from "node:assert/strict";
import { actOnPending, answerRestoreInit, restoreBanner, type RestoreEvent } from "../src/lib/restoreBanner.ts";

const ev = (p: Partial<RestoreEvent>): RestoreEvent => ({ ev: "restore", stage: "spawn", total: 22, done: 0, ...p });

test("sem evento não mostra nada", () => {
  assert.equal(restoreBanner(null), null);
});

test("progresso: conta os terminais", () => {
  assert.deepEqual(restoreBanner(ev({ done: 3 })), { text: "Restaurando terminais (3 de 22)…", busy: true, details: [] });
  // o contador nunca passa do total
  assert.equal(restoreBanner(ev({ done: 30 }))?.text, "Restaurando terminais (22 de 22)…");
  assert.equal(restoreBanner(ev({ total: 0, stage: "start" }))?.text, "Restaurando terminais…");
});

test("espera do WSL cita a distro", () => {
  const b = restoreBanner(ev({ stage: "wsl", distro: "Debian", message: "Aguardando o WSL (Debian)…" }));
  assert.deepEqual(b, { text: "Aguardando o WSL (Debian)…", busy: true, details: [] });
  assert.equal(restoreBanner(ev({ stage: "wsl", distro: "Ubuntu" }))?.text, "Aguardando o WSL (Ubuntu)…");
});

test("pergunta do init: uma pasta ausente", () => {
  const b = restoreBanner(ev({ stage: "ask_init", distro: "Debian", missing: ["/mnt/kingston/mcu/repo"] }));
  assert.equal(b?.text, "A pasta /mnt/kingston/mcu/repo não existe no WSL Debian. Executar o script de inicialização?");
  assert.equal(b?.busy, false);
  assert.deepEqual(b?.ask, { distro: "Debian", missing: ["/mnt/kingston/mcu/repo"] });
});

test("pergunta do init: várias pastas ausentes citam a primeira e quantas mais", () => {
  const b = restoreBanner(ev({ stage: "ask_init", distro: "Ubuntu", missing: ["/mnt/a", "/mnt/b", "/mnt/c"] }));
  assert.equal(b?.text, "A pasta /mnt/a (e mais 2) não existe no WSL Ubuntu. Executar o script de inicialização?");
  assert.equal(b?.ask?.missing.length, 3);
});

test("pergunta do init sem lista de pastas ainda faz sentido", () => {
  const b = restoreBanner(ev({ stage: "ask_init", distro: "Debian" }));
  assert.equal(b?.text, "Há pastas que não existem no WSL Debian. Executar o script de inicialização?");
  assert.deepEqual(b?.ask, { distro: "Debian", missing: [] });
});

test("init em andamento: espera com o tempo corrido", () => {
  const b = restoreBanner(ev({ stage: "init", distro: "Debian", message: "Aguardando o init do WSL (Debian)… 42 s" }));
  assert.deepEqual(b, { text: "Aguardando o init do WSL (Debian)… 42 s", busy: true, details: [], init: { distro: "Debian" } });
  assert.equal(restoreBanner(ev({ stage: "init", distro: "Ubuntu" }))?.text, "Executando o init do WSL (Ubuntu)…");
});

test("tudo certo: aviso curto que some em 8 s", () => {
  const done = ev({ stage: "finished", done: 22 });
  assert.equal(restoreBanner(done, 1000, 1000)?.text, "22 terminais restaurados.");
  assert.equal(restoreBanner(done, 20000, 1000), null);
  assert.equal(restoreBanner(ev({ stage: "finished", total: 1, done: 1 }), 1000, 1000)?.text, "1 terminal restaurado.");
});

test("resumo com falhas e avisos", () => {
  const b = restoreBanner(
    ev({
      stage: "finished",
      total: 5,
      done: 3,
      failed: [{ pane_id: 2, title: "build", reason: "a distro Debian não respondeu em 60 s" }],
      warnings: ["O init do WSL (Debian) falhou: o comando saiu com código 2"],
    }),
  );
  assert.equal(b?.text, "3 de 5 restaurados, 1 não voltou.");
  assert.equal(b?.busy, false);
  assert.deepEqual(b?.details, ["build: a distro Debian não respondeu em 60 s", "O init do WSL (Debian) falhou: o comando saiu com código 2"]);
});

test("resumo com terminais aguardando a pasta traz a lista e não some sozinho", () => {
  const pending = [
    { pane_id: 3, title: "arte-maior", distro: "Debian", cwd: "/mnt/kingston/mcu/repo/a" },
    { pane_id: 4, distro: "Debian", cwd: "/mnt/kingston/mcu/repo/b", keep: true },
  ];
  const b = restoreBanner(ev({ stage: "finished", total: 5, done: 3, pending }), 999999, 1000);
  assert.equal(b?.text, "3 de 5 restaurados, 2 aguardando a pasta.");
  assert.deepEqual(b?.pending, pending);
  assert.equal(restoreBanner(ev({ stage: "finished", total: 2, done: 1, pending: [pending[0]] }), 1000, 1000)?.text, "1 de 2 restaurados, 1 aguardando a pasta.");
});

test("falhas no plural e terminal sem título", () => {
  const b = restoreBanner(
    ev({ stage: "finished", total: 4, done: 2, failed: [{ pane_id: 1, reason: "x" }, { pane_id: 2, reason: "y" }] }),
  );
  assert.equal(b?.text, "2 de 4 restaurados, 2 não voltaram.");
  assert.deepEqual(b?.details, ["Terminal 1: x", "Terminal 2: y"]);
});

test("pendentes resolvidos: lista vazia volta ao aviso de tudo certo", () => {
  const b = restoreBanner(ev({ stage: "finished", total: 3, done: 3, pending: [] }), 1000, 1000);
  assert.equal(b?.text, "3 terminais restaurados.");
  assert.equal(b?.pending, undefined);
});

test("ações do banner chamam a API certa", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const conn = {
    api: async (path: string, body?: unknown) => {
      calls.push({ path, body });
      return { ok: true, opened: true };
    },
  } as never;
  await answerRestoreInit(conn, "Debian", "run");
  const r = await actOnPending(conn, 3, "retry");
  assert.deepEqual(calls, [
    { path: "/api/restore/answer", body: { distro: "Debian", action: "run" } },
    { path: "/api/restore/pending", body: { pane_id: 3, action: "retry" } },
  ]);
  assert.equal(r.opened, true);
});
