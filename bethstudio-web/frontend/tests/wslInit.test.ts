import { test } from "node:test";
import assert from "node:assert/strict";
import { cfgFor, loadWslInit, saveWslInit, testWslInit, validateWslInit, type WslInitCfg } from "../src/lib/wslInit.ts";

const ok = (p: Partial<WslInitCfg> = {}): WslInitCfg => ({ enabled: true, command: "init-wsl2", timeout_sec: 300, ...p });

test("validateWslInit aceita uma configuração boa e uma desligada vazia", () => {
  assert.equal(validateWslInit(ok()), null);
  assert.equal(validateWslInit({ enabled: false, command: "", timeout_sec: 300 }), null);
  assert.equal(validateWslInit(ok({ default_dir: "/mnt/kingston/mcu" })), null);
});

test("validateWslInit recusa o que o Studio recusaria (o comando vira texto digitado)", () => {
  assert.match(validateWslInit(ok({ command: "a\nb" })) ?? "", /quebra de linha/);
  assert.match(validateWslInit(ok({ command: "a\rb" })) ?? "", /quebra de linha/);
  assert.match(validateWslInit(ok({ command: "x".repeat(1025) })) ?? "", /1024/);
  assert.match(validateWslInit(ok({ command: "   " })) ?? "", /comando/);
  assert.match(validateWslInit(ok({ default_dir: "relativa" })) ?? "", /começa com \//);
  assert.match(validateWslInit(ok({ timeout_sec: 5 })) ?? "", /entre 10 e 1800/);
  assert.match(validateWslInit(ok({ timeout_sec: 5000 })) ?? "", /entre 10 e 1800/);
  assert.match(validateWslInit(ok({ timeout_sec: Number.NaN })) ?? "", /entre 10 e 1800/);
});

test("cfgFor acha a configuração sem distinguir maiúsculas e dá o padrão quando não há", () => {
  const state = { distros: ["Ubuntu"], config: { ubuntu: ok({ command: "init-wsl2" }) } };
  assert.equal(cfgFor(state, "Ubuntu").command, "init-wsl2");
  assert.equal(cfgFor(state, "UBUNTU").command, "init-wsl2");
  assert.deepEqual(cfgFor(state, "Debian"), { enabled: false, command: "", timeout_sec: 300 });
});

test("a tela fala com /api/wsl-init (e o teste com /api/wsl-init/test)", async () => {
  const calls: { path: string; body?: unknown }[] = [];
  const state = { distros: ["Ubuntu"], config: {} };
  const conn = {
    api: async (path: string, body?: unknown) => {
      calls.push({ path, body });
      return state;
    },
  } as never;
  assert.deepEqual(await loadWslInit(conn), state);
  await saveWslInit(conn, "Ubuntu", ok());
  await testWslInit(conn, "Ubuntu");
  assert.deepEqual(calls, [
    { path: "/api/wsl-init", body: undefined },
    { path: "/api/wsl-init", body: { distro: "Ubuntu", config: ok() } },
    { path: "/api/wsl-init/test", body: { distro: "Ubuntu" } },
  ]);
});
