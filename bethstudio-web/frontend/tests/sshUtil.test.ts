import { test } from "node:test";
import assert from "node:assert/strict";
import {
  breadcrumbs,
  formatSize,
  groupBy,
  hostFormError,
  hostTarget,
  joinRemote,
  matchesHost,
  NO_GROUP,
  portLabel,
  recentItems,
  serialFormError,
  serialShort,
  validRemoteName,
} from "../src/lib/sshUtil.ts";
import { b64utf8, type SshHost } from "../src/lib/sshApi.ts";

const host = (o: Partial<SshHost>): SshHost => ({
  id: o.id ?? "0000000000000001",
  name: o.name ?? "srv",
  host: o.host ?? "10.0.0.1",
  port: o.port ?? 22,
  user: o.user ?? "root",
  auth: o.auth ?? "password",
  has_password: false,
  has_passphrase: false,
  ...o,
});

test("busca por várias palavras em nome, endereço, grupo e etiqueta", () => {
  const h = host({ name: "Banco produção", host: "db.exemplo.org", group: "Clientes", tag: "pg" });
  assert.ok(matchesHost(h, "banco pg"));
  assert.ok(matchesHost(h, "root@db"));
  assert.ok(matchesHost(h, ""));
  assert.ok(!matchesHost(h, "banco mysql"));
});

test("agrupa com 'Sem grupo' por último e ordena por nome", () => {
  const g = groupBy([host({ name: "b", group: "Lab" }), host({ name: "z" }), host({ name: "a", group: "Lab" }), host({ name: "c", group: "Casa" })]);
  assert.deepEqual(
    g.map((x) => [x.group, x.items.map((i) => i.name)]),
    [
      ["Casa", ["c"]],
      ["Lab", ["a", "b"]],
      [NO_GROUP, ["z"]],
    ],
  );
});

test("recentes ignoram hosts apagados", () => {
  const a = host({ id: "a" }),
    b = host({ id: "b" });
  assert.deepEqual(
    recentItems([{ id: "x", at: "" }, { id: "b", at: "" }, { id: "a", at: "" }], [a, b]).map((h) => h.id),
    ["b", "a"],
  );
});

test("alvo, caminhos remotos e nomes", () => {
  assert.equal(hostTarget({ user: "u", host: "h", port: 22 }), "u@h");
  assert.equal(hostTarget({ user: "u", host: "fe80::1", port: 2222 }), "u@[fe80::1]:2222");
  assert.equal(joinRemote("/home/u", "a.txt"), "/home/u/a.txt");
  assert.equal(joinRemote("/", "etc"), "/etc");
  assert.deepEqual(
    breadcrumbs("/home/u").map((b) => b.path),
    ["/", "/home", "/home/u"],
  );
  assert.equal(validRemoteName("ok.txt"), null);
  assert.ok(validRemoteName("a/b"));
  assert.ok(validRemoteName(".."));
  assert.ok(validRemoteName("  "));
});

test("tamanhos em pt-BR", () => {
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(1536), "1,5 KB");
  assert.equal(formatSize(5 * 1024 * 1024 * 1024), "5 GB");
});

test("validação do formulário de host", () => {
  assert.equal(hostFormError({ host: "srv", user: "u", port: 22, auth: "password" }), null);
  assert.ok(hostFormError({ host: "u@srv", user: "u" }));
  assert.ok(hostFormError({ host: "srv", user: "" }));
  assert.ok(hostFormError({ host: "srv", user: "u", port: 0 }));
  assert.ok(hostFormError({ host: "srv", user: "u", auth: "key", key_path: "" }));
});

test("serial: resumo, rótulo de porta e validação", () => {
  assert.equal(serialShort({ baud: 115200, data_bits: 8, parity: "none", stop_bits: "1" }), "115200 8N1");
  assert.equal(portLabel({ port: "COM3", friendly_name: "USB-SERIAL CH340 (COM3)", vid: "1A86", pid: "7523" }), "COM3 — USB-SERIAL CH340 (1A86:7523)");
  assert.equal(portLabel({ port: "COM1" }), "COM1");
  assert.equal(serialFormError({ port: "COM3", baud: 9600, data_bits: 8, stop_bits: "1" }), null);
  assert.ok(serialFormError({ port: "3", baud: 9600 }));
  assert.ok(serialFormError({ port: "COM3", baud: 9600, data_bits: 8, stop_bits: "1.5" }));
  assert.ok(serialFormError({ port: "COM3", baud: 9600, log_file: "log.txt" }));
  assert.equal(serialFormError({ port: "COM3", baud: 9600, log_file: "C:\\logs\\a.log" }), null);
});

test("senha no cabeçalho vai em base64 de UTF-8", () => {
  assert.equal(b64utf8("ç"), "w6c=");
});
