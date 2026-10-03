import { test } from "node:test";
import assert from "node:assert/strict";
import { hostBanner, type HostEvent } from "../src/lib/hostBanner.ts";

const ev = (state: HostEvent["state"], message = ""): HostEvent => ({ ev: "host", state, message });

test("sem evento ou com host de pé não mostra faixa", () => {
  assert.equal(hostBanner(null), null);
  assert.equal(hostBanner(ev("running")), null);
  assert.equal(hostBanner(ev("quitting", "Encerrando o Beth Studio…")), null);
  assert.equal(hostBanner(ev("gui-managed", "A janela nativa antiga está cuidando do host.")), null);
  assert.equal(hostBanner(ev("unmanaged")), null);
});

test("host indisponível mostra o motivo e o botão Tentar de novo", () => {
  assert.deepEqual(hostBanner(ev("unavailable", "O host caiu 3 vezes em 10 minutos.")), {
    text: "O host caiu 3 vezes em 10 minutos.",
    retry: true,
  });
  assert.deepEqual(hostBanner(ev("unavailable")), { text: "O host está indisponível.", retry: true });
});

test("iniciando normalmente não mostra faixa, falha ao iniciar mostra o motivo", () => {
  assert.equal(hostBanner(ev("starting", "Iniciando o host…")), null);
  assert.deepEqual(hostBanner(ev("starting", "Não foi possível iniciar o host: bethstudio-host.exe não encontrado")), {
    text: "Não foi possível iniciar o host: bethstudio-host.exe não encontrado",
    retry: false,
  });
});
