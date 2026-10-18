import { normalizeDomain, originOf, urlFor } from "../domain";

describe("normalizeDomain", () => {
  it("aceita o domínio puro e põe em minúsculas", () => {
    expect(normalizeDomain("Beth.Exemplo.com.br")).toEqual({ ok: true, host: "beth.exemplo.com.br" });
  });

  it("tira https://, caminho, consulta e barra final", () => {
    expect(normalizeDomain("  https://beth.exemplo.com/studio/?x=1 ")).toEqual({ ok: true, host: "beth.exemplo.com" });
    expect(normalizeDomain("beth.exemplo.com/")).toEqual({ ok: true, host: "beth.exemplo.com" });
  });

  it("aceita porta válida", () => {
    expect(normalizeDomain("beth.exemplo.com:8443")).toEqual({ ok: true, host: "beth.exemplo.com:8443" });
  });

  it("recusa http:// (só HTTPS)", () => {
    const r = normalizeDomain("http://beth.exemplo.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/https/i);
  });

  it("recusa vazio, espaço no meio, usuário@ e outros esquemas", () => {
    for (const bad of ["", "   ", "beth exemplo.com", "user@beth.exemplo.com", "ftp://x.com", "javascript:alert(1)"]) {
      expect(normalizeDomain(bad).ok).toBe(false);
    }
  });

  it("recusa nome sem ponto, IP e porta fora da faixa", () => {
    for (const bad of ["localhost", "192.168.0.10", "10.0.0.1:8080", "beth.exemplo.com:0", "beth.exemplo.com:70000", "beth.exemplo.com:abc"]) {
      expect(normalizeDomain(bad).ok).toBe(false);
    }
  });

  it("recusa rótulos inválidos", () => {
    for (const bad of ["-a.com", "a..com", "a_b.com", ".com"]) {
      expect(normalizeDomain(bad).ok).toBe(false);
    }
  });
});

describe("originOf / urlFor", () => {
  it("monta origem e URLs https", () => {
    expect(originOf("beth.exemplo.com")).toBe("https://beth.exemplo.com");
    expect(urlFor("beth.exemplo.com", "/api/phone/me")).toBe("https://beth.exemplo.com/api/phone/me");
  });
});
