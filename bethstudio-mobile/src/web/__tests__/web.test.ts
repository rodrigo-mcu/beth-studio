import { deliverTextScript, isAllowedNavigation, loginScript, parseAck, shouldWake, wakeScript } from "../inject";

describe("isAllowedNavigation", () => {
  const host = "beth.exemplo.com";
  it("deixa só https do mesmo domínio dentro do app", () => {
    expect(isAllowedNavigation("https://beth.exemplo.com/", host)).toBe(true);
    expect(isAllowedNavigation("https://beth.exemplo.com/assets/x.js?v=1", host)).toBe(true);
    expect(isAllowedNavigation("about:blank", host)).toBe(true);
  });
  it("recusa outro domínio, http, esquemas estranhos e truque de subdomínio", () => {
    expect(isAllowedNavigation("https://evil.com/", host)).toBe(false);
    expect(isAllowedNavigation("http://beth.exemplo.com/", host)).toBe(false);
    expect(isAllowedNavigation("https://beth.exemplo.com.evil.com/", host)).toBe(false);
    expect(isAllowedNavigation("https://evil.com/?https://beth.exemplo.com/", host)).toBe(false);
    expect(isAllowedNavigation("javascript:alert(1)", host)).toBe(false);
    expect(isAllowedNavigation("file:///etc/passwd", host)).toBe(false);
    expect(isAllowedNavigation("intent://x#Intent;end", host)).toBe(false);
  });
  it("respeita a porta quando o domínio tem porta", () => {
    expect(isAllowedNavigation("https://beth.exemplo.com:8443/x", "beth.exemplo.com:8443")).toBe(true);
    expect(isAllowedNavigation("https://beth.exemplo.com/x", "beth.exemplo.com:8443")).toBe(false);
  });
});

/** Roda o script como o WebView rodaria, num "navegador" falso mínimo. */
function run(script: string, env: Record<string, unknown>) {
  const names = Object.keys(env);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(...names, `${script}`);
  return fn(...names.map((n) => env[n]));
}

describe("loginScript", () => {
  it("é JavaScript válido e leva a senha escapada (aspas, barra, quebra de linha, </script>)", () => {
    const pw = 'a"b\\c\n</script> x';
    const script = loginScript(pw);
    expect(() => new Function(script)).not.toThrow();
    const calls: { url: string; init: { method?: string; body?: string } }[] = [];
    const fetchFake = (url: string, init: { method?: string; body?: string }) => {
      calls.push({ url, init });
      return Promise.resolve({ status: url.includes("/me") ? 401 : 200, ok: false });
    };
    run(script, { fetch: fetchFake, location: { reload: () => undefined }, setTimeout });
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        const login = calls.find((c) => c.url === "/api/phone/login");
        expect(login).toBeDefined();
        expect(JSON.parse(login?.init.body ?? "{}")).toEqual({ password: pw });
        resolve();
      }, 20),
    );
  });

  it("não entra de novo se a sessão já vale", async () => {
    const calls: string[] = [];
    run(loginScript("x"), {
      fetch: (url: string) => {
        calls.push(url);
        return Promise.resolve({ status: 200, ok: true });
      },
      location: { reload: () => undefined },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(["/api/phone/me"]);
  });
});

describe("deliverTextScript", () => {
  function fakeDom(value: string) {
    const events: string[] = [];
    const ta = {
      value,
      focus: () => events.push("focus"),
      dispatchEvent: (e: { type: string }) => events.push(e.type),
    };
    const posted: string[] = [];
    return {
      ta,
      events,
      posted,
      env: {
        document: { querySelector: (sel: string) => (sel.includes("textarea") ? ta : null) },
        window: { ReactNativeWebView: { postMessage: (m: string) => posted.push(m) } },
        Event: class {
          constructor(public type: string) {}
        },
        Object: Object,
        HTMLTextAreaElement: {
          prototype: {},
        },
      },
    };
  }

  it("é JavaScript válido com texto cheio de caracteres especiais", () => {
    expect(() => new Function(deliverTextScript("t1", 'oi "mundo" \\ \n </script>  '))).not.toThrow();
  });

  it("junta ao que já está no campo, dispara 'input' e confirma com o id", () => {
    const d = fakeDom("já escrito  ");
    const setter = jest.fn(function (this: { value: string }, v: string) {
      this.value = v;
    });
    Object.defineProperty(d.env.HTMLTextAreaElement.prototype, "value", { set: setter, get: () => "" });
    run(deliverTextScript("t1", "texto novo"), d.env);
    expect(d.ta.value).toBe("já escrito texto novo");
    expect(d.events).toContain("input");
    expect(JSON.parse(d.posted[0] ?? "{}")).toEqual({ beth: "ack", id: "t1", ok: true });
  });

  it("sem campo de mensagem na tela, confirma com ok:false (o texto fica no app)", () => {
    const posted: string[] = [];
    run(deliverTextScript("t2", "x"), {
      document: { querySelector: () => null },
      window: { ReactNativeWebView: { postMessage: (m: string) => posted.push(m) } },
      Event: class {},
      Object,
      HTMLTextAreaElement: { prototype: {} },
    });
    expect(JSON.parse(posted[0] ?? "{}")).toEqual({ beth: "ack", id: "t2", ok: false });
  });
});

describe("parseAck", () => {
  it("só aceita a mensagem no formato combinado", () => {
    expect(parseAck('{"beth":"ack","id":"t1","ok":true}')).toEqual({ id: "t1", ok: true });
    expect(parseAck('{"beth":"ack","id":"t1","ok":false}')).toEqual({ id: "t1", ok: false });
    expect(parseAck('{"beth":"outra","id":"t1","ok":true}')).toBeNull();
    expect(parseAck('{"beth":"ack","id":5,"ok":true}')).toBeNull();
    expect(parseAck("lixo")).toBeNull();
    expect(parseAck("")).toBeNull();
  });
});

describe("wakeScript / shouldWake", () => {
  it("avisa o web app que voltou à tela e que a rede voltou", () => {
    const events: string[] = [];
    run(wakeScript(), {
      window: { dispatchEvent: (e: { type: string }) => events.push(`w:${e.type}`) },
      document: { dispatchEvent: (e: { type: string }) => events.push(`d:${e.type}`) },
      Event: class {
        constructor(public type: string) {}
      },
    });
    expect(events).toEqual(["w:online", "d:visibilitychange"]);
  });

  it("acorda ao voltar para o app e quando a rede volta, não nas outras trocas", () => {
    expect(shouldWake({ appState: "background", online: true }, { appState: "active", online: true })).toBe(true);
    expect(shouldWake({ appState: "inactive", online: true }, { appState: "active", online: true })).toBe(true);
    expect(shouldWake({ appState: "active", online: false }, { appState: "active", online: true })).toBe(true);
    expect(shouldWake({ appState: "active", online: true }, { appState: "active", online: true })).toBe(false);
    expect(shouldWake({ appState: "active", online: true }, { appState: "background", online: true })).toBe(false);
    expect(shouldWake({ appState: "active", online: true }, { appState: "active", online: false })).toBe(false);
  });
});
