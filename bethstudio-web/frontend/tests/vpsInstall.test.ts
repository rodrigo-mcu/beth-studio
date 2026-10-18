import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyForm,
  fingerprintNotice,
  firstError,
  fullDomain,
  installBody,
  stepStatuses,
  validateHost,
  validatePhonePassword,
  validatePort,
  validateServerForm,
  validateSubdomain,
  validateUser,
  type VpsEvent,
} from "../src/lib/vpsInstall.ts";

test("subdomínio e domínio final", () => {
  assert.equal(validateSubdomain("agentes", "exemplo.com"), null);
  assert.equal(validateSubdomain("", "exemplo.com"), null);
  assert.equal(validateSubdomain("a.b", "exemplo.com"), null);
  assert.match(validateSubdomain("a b", "exemplo.com") ?? "", /letras/);
  assert.match(validateSubdomain("a;rm", "exemplo.com") ?? "", /letras/);
  assert.match(validateSubdomain("-a", "exemplo.com") ?? "", /letras/);
  assert.match(validateSubdomain("a", "") ?? "", /zona/);
  assert.equal(fullDomain("Agentes", "exemplo.com"), "agentes.exemplo.com");
  assert.equal(fullDomain("", "exemplo.com"), "exemplo.com");
});

test("host, porta e usuário", () => {
  assert.equal(validateHost("203.0.113.9"), null);
  assert.equal(validateHost("vps.exemplo.com"), null);
  assert.equal(validateHost("2001:db8::1"), null);
  assert.match(validateHost("") ?? "", /Informe/);
  assert.match(validateHost("https://x.com") ?? "", /sem https/);
  assert.match(validateHost("x.com:22") ?? "", /sem https/);
  assert.match(validateHost("a;b") ?? "", /sem https/);
  assert.equal(validatePort("22"), null);
  assert.equal(validatePort("65535"), null);
  assert.match(validatePort("0") ?? "", /inválida/);
  assert.match(validatePort("x") ?? "", /inválida/);
  assert.equal(validateUser("root"), null);
  assert.match(validateUser("Root") ?? "", /inválido/);
  assert.match(validateUser("a b") ?? "", /inválido/);
});

test("senha do celular: 8+ ou já existente", () => {
  assert.equal(validatePhonePassword("", true), null);
  assert.match(validatePhonePassword("", false) ?? "", /8 caracteres/);
  assert.match(validatePhonePassword("curta", true) ?? "", /8 caracteres/);
  assert.equal(validatePhonePassword("12345678", false), null);
});

test("formulário do servidor exige senha ou chave", () => {
  const f = { ...emptyForm(), host: "203.0.113.9" };
  assert.match(validateServerForm(f) ?? "", /senha do servidor/);
  assert.equal(validateServerForm({ ...f, password: "x" }), null);
  const k = { ...f, authKind: "key" as const };
  assert.match(validateServerForm(k) ?? "", /chave privada/);
  assert.equal(validateServerForm({ ...k, privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----" }), null);
});

test("o pedido de instalação usa só o modo de autenticação escolhido", () => {
  const f = { ...emptyForm(), host: "h.exemplo.com", zoneId: "aaa", zoneName: "exemplo.com", token: "tok", password: "pw", privateKey: "KEY PRIVATE KEY", passphrase: "pp", phonePassword: "senha-celular" };
  const a = installBody(f, "SHA256:x", false);
  assert.equal(a.private_key, "");
  assert.equal(a.passphrase, "");
  assert.equal(a.domain, "agentes.exemplo.com");
  assert.equal(a.cf_token, "tok");
  const b = installBody({ ...f, authKind: "key" }, "SHA256:x", true);
  assert.equal(b.private_key, "KEY PRIVATE KEY");
  assert.equal(b.replace_known, true);
});

test("estado dos passos vem do último evento de cada um", () => {
  const ev: VpsEvent[] = [
    { seq: 1, step: "connect", status: "running", msg: "x" },
    { seq: 2, step: "connect", status: "ok", msg: "x" },
    { seq: 3, step: "preflight", status: "running", msg: "x" },
    { seq: 4, step: "preflight", status: "error", msg: "porta 80", hint: "libere" },
    { seq: 5, step: "dns", status: "info", msg: "x" },
    { seq: 6, step: "outro-desconhecido", status: "ok", msg: "x" },
  ];
  const s = stepStatuses(ev);
  assert.equal(s.connect, "ok");
  assert.equal(s.preflight, "error");
  assert.equal(s.dns, "pending");
  assert.equal(s.verify, "pending");
  assert.deepEqual(firstError(ev), { step: "preflight", msg: "porta 80", hint: "libere" });
  assert.equal(firstError([]), null);
});

test("aviso da impressão digital muda de tom quando ela mudou", () => {
  assert.equal(fingerprintNotice("new").tone, "info");
  assert.equal(fingerprintNotice("known").tone, "ok");
  const c = fingerprintNotice("changed", "SHA256:antiga");
  assert.equal(c.tone, "danger");
  assert.match(c.text, /SHA256:antiga/);
});
