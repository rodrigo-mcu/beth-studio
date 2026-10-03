import { test } from "node:test";
import assert from "node:assert/strict";
import { restoreBanner, type RestoreEvent } from "../src/lib/restoreBanner.ts";

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

test("tudo certo: aviso curto que some em 8 s", () => {
  const done = ev({ stage: "finished", done: 22 });
  assert.equal(restoreBanner(done, 1000, 1000)?.text, "22 terminais restaurados.");
  assert.equal(restoreBanner(done, 20000, 1000), null);
  assert.equal(restoreBanner(ev({ stage: "finished", total: 1, done: 1 }), 1000, 1000)?.text, "1 terminal restaurado.");
});

test("resumo com falhas, pastas na home e avisos", () => {
  const b = restoreBanner(
    ev({
      stage: "finished",
      total: 5,
      done: 3,
      failed: [{ pane_id: 2, title: "build", reason: "a distro Debian não respondeu em 60 s" }],
      fallbacks: [{ pane_id: 3, cwd: "/mnt/data/app" }],
      warnings: ["o comando de inicialização de Debian falhou"],
    }),
  );
  assert.equal(b?.text, "3 de 5 restaurados, 1 não voltou, 1 abriu na pasta inicial.");
  assert.equal(b?.busy, false);
  assert.deepEqual(b?.details, [
    "build: a distro Debian não respondeu em 60 s",
    "A pasta /mnt/data/app ainda não existia; o terminal abriu na pasta inicial.",
    "o comando de inicialização de Debian falhou",
  ]);
});

test("falhas no plural e terminal sem título", () => {
  const b = restoreBanner(
    ev({ stage: "finished", total: 4, done: 2, failed: [{ pane_id: 1, reason: "x" }, { pane_id: 2, reason: "y" }] }),
  );
  assert.equal(b?.text, "2 de 4 restaurados, 2 não voltaram.");
  assert.deepEqual(b?.details, ["Terminal 1: x", "Terminal 2: y"]);
});
