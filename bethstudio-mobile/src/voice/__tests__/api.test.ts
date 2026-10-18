import { ApiError } from "../retry";
import { parseSessionCookie, PhoneApi, type HttpResult } from "../api";

const HOST = "beth.exemplo.com";

describe("parseSessionCookie", () => {
  it("acha o cookie do celular num Set-Cookie simples", () => {
    expect(parseSessionCookie("bethstudio_phone=abc123; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict")).toBe("abc123");
  });
  it("acha quando o RN junta vários Set-Cookie com vírgula", () => {
    expect(parseSessionCookie("outro=1; Path=/, bethstudio_phone=tok-9_x; Path=/; HttpOnly")).toBe("tok-9_x");
  });
  it("devolve null sem cookie, vazio ou apagado (Max-Age<0)", () => {
    expect(parseSessionCookie(null)).toBeNull();
    expect(parseSessionCookie("")).toBeNull();
    expect(parseSessionCookie("x=1")).toBeNull();
    expect(parseSessionCookie("bethstudio_phone=; Max-Age=0")).toBeNull();
  });
});

function api(handler: (req: { url: string; method: string; headers: Record<string, string>; body?: string }) => HttpResult | Promise<HttpResult>) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string; file?: string }[] = [];
  const http = {
    request: jest.fn(async (req: { url: string; method: string; headers: Record<string, string>; body?: string }) => {
      calls.push(req);
      return handler(req);
    }),
    uploadFile: jest.fn(async (req: { url: string; headers: Record<string, string>; fileUri: string }) => {
      calls.push({ url: req.url, method: "POST", headers: req.headers, file: req.fileUri });
      return handler({ url: req.url, method: "POST", headers: req.headers });
    }),
  };
  return { a: new PhoneApi({ host: HOST, getPassword: async () => "segredo", http }), calls, http };
}

const ok = (body: unknown, headers: Record<string, string> = {}): HttpResult => ({ status: 200, body: JSON.stringify(body), headers });

describe("PhoneApi.transcribe", () => {
  it("entra uma vez, manda Origin, Cookie, tipo e duração, devolve o texto", async () => {
    const { a, calls } = api((r) => {
      if (r.url.endsWith("/api/phone/login")) return ok({ ok: true }, { "set-cookie": "bethstudio_phone=TOK; Path=/; HttpOnly" });
      return ok({ text: "olá mundo" });
    });
    expect(await a.transcribe("file:///a.m4a", 12.4)).toBe("olá mundo");
    expect(await a.transcribe("file:///b.m4a", 3)).toBe("olá mundo");
    const logins = calls.filter((c) => c.url.endsWith("/api/phone/login"));
    expect(logins).toHaveLength(1);
    expect(JSON.parse(logins[0]?.body ?? "{}")).toEqual({ password: "segredo" });
    expect(logins[0]?.headers["Origin"]).toBe("https://beth.exemplo.com");
    const up = calls.find((c) => c.file === "file:///a.m4a");
    expect(up?.url).toBe("https://beth.exemplo.com/api/voice/transcribe");
    expect(up?.headers["Cookie"]).toBe("bethstudio_phone=TOK");
    expect(up?.headers["Origin"]).toBe("https://beth.exemplo.com");
    expect(up?.headers["Content-Type"]).toBe("audio/mp4");
    expect(up?.headers["X-Audio-Ms"]).toBe("12400");
  });

  it("sessão vencida (401): entra de novo uma vez e repete", async () => {
    let n = 0;
    const { a, calls } = api((r) => {
      if (r.url.endsWith("/api/phone/login")) return ok({ ok: true }, { "set-cookie": `bethstudio_phone=T${++n}; Path=/` });
      if (r.headers["Cookie"] === "bethstudio_phone=T1") return { status: 401, body: "login", headers: {} };
      return ok({ text: "certo" });
    });
    expect(await a.transcribe("file:///a.m4a", 1)).toBe("certo");
    expect(calls.filter((c) => c.url.endsWith("/login"))).toHaveLength(2);
  });

  it("senha recusada: erro de autenticação, que não se repete", async () => {
    const { a } = api(() => ({ status: 401, body: JSON.stringify({ error: "Senha incorreta." }), headers: {} }));
    const e = await a.transcribe("file:///a.m4a", 1).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).kind).toBe("auth");
    expect((e as ApiError).message).toBe("Senha incorreta.");
  });

  it("5xx do proxy vira erro repetível, com o status", async () => {
    const { a } = api((r) => {
      if (r.url.endsWith("/login")) return ok({}, { "set-cookie": "bethstudio_phone=T" });
      return { status: 503, body: "", headers: {} };
    });
    const e = (await a.transcribe("file:///a.m4a", 1).catch((x: unknown) => x)) as ApiError;
    expect(e.status).toBe(503);
    expect(e.message).toMatch(/503/);
  });

  it("usa o 'kind' que o Go manda", async () => {
    const { a } = api((r) => {
      if (r.url.endsWith("/login")) return ok({}, { "set-cookie": "bethstudio_phone=T" });
      return { status: 502, body: JSON.stringify({ error: "provedor caiu", kind: "timeout" }), headers: {} };
    });
    const e = (await a.transcribe("file:///a.m4a", 1).catch((x: unknown) => x)) as ApiError;
    expect(e.kind).toBe("timeout");
    expect(e.message).toBe("provedor caiu");
  });

  it("falha de rede vira ApiError 'network'", async () => {
    const http = {
      request: jest.fn(async () => {
        throw new TypeError("Network request failed");
      }),
      uploadFile: jest.fn(),
    };
    const a = new PhoneApi({ host: HOST, getPassword: async () => "x", http });
    const e = (await a.transcribe("file:///a.m4a", 1).catch((x: unknown) => x)) as ApiError;
    expect(e.kind).toBe("network");
  });

  it("login sem cookie na resposta é erro claro", async () => {
    const { a } = api(() => ok({ ok: true }));
    const e = (await a.transcribe("file:///a.m4a", 1).catch((x: unknown) => x)) as ApiError;
    expect(e.message).toMatch(/sess/i);
  });
});

describe("PhoneApi.privacy", () => {
  it("lê privacy_ack e grava a confirmação", async () => {
    const { a, calls } = api((r) => {
      if (r.url.endsWith("/login")) return ok({}, { "set-cookie": "bethstudio_phone=T" });
      if (r.url.endsWith("/api/voice")) return ok({ settings: { privacy_ack: false } });
      return ok({ settings: { privacy_ack: true } });
    });
    expect(await a.privacyAcked()).toBe(false);
    await a.ackPrivacy();
    const post = calls.find((c) => c.url.endsWith("/api/voice/settings"));
    expect(post?.method).toBe("POST");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({ privacy_ack: true });
  });
});
