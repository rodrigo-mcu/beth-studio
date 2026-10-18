// Chamadas do app nativo ao PC (as mesmas que o web app do celular faz; veja
// bethstudio-web/phone_gate.go): login por senha, /api/voice e
// /api/voice/transcribe. A rede entra por `http` (injetado), então a lógica
// (sessão, nova entrada no 401, tradução de erros) é testável sem aparelho.

import { originOf, urlFor } from "@/config/domain";
import { ApiError, type ApiErrorKind } from "./retry";

export const COOKIE_NAME = "bethstudio_phone";

export interface HttpResult {
  status: number;
  body: string;
  /** nomes em minúsculas */
  headers: Record<string, string>;
}

export interface HttpClient {
  request(req: { url: string; method: string; headers: Record<string, string>; body?: string }): Promise<HttpResult>;
  /** envia o arquivo do disco como corpo (sem carregar tudo na memória) */
  uploadFile(req: { url: string; headers: Record<string, string>; fileUri: string }): Promise<HttpResult>;
}

/** Valor do cookie de sessão num cabeçalho Set-Cookie (o RN junta vários com vírgula). */
export function parseSessionCookie(setCookie: string | null | undefined): string | null {
  if (!setCookie) return null;
  const m = new RegExp(`(?:^|[,;\\s])${COOKIE_NAME}=([^;,\\s]*)`).exec(setCookie);
  const v = m?.[1];
  return v ? v : null;
}

const KINDS: readonly string[] = ["network", "timeout", "rate_limit", "auth", "canceled", "empty"];

function errorFrom(r: HttpResult, fallback: string): ApiError {
  let message = `${fallback} (HTTP ${r.status})`;
  let kind: ApiErrorKind | undefined;
  try {
    const j = JSON.parse(r.body) as { error?: unknown; kind?: unknown };
    if (typeof j.error === "string" && j.error) message = j.error;
    if (typeof j.kind === "string" && KINDS.includes(j.kind)) kind = j.kind as ApiErrorKind;
  } catch {
    /* corpo não é JSON (ex. página do proxy) */
  }
  if (r.status === 401 && !kind) kind = "auth";
  return new ApiError(message, { kind, status: r.status });
}

export interface PhoneApiOptions {
  host: string;
  getPassword: () => Promise<string | null>;
  http: HttpClient;
}

export class PhoneApi {
  private cookie: string | null = null;
  private loginInFlight: Promise<string> | null = null;

  constructor(private readonly o: PhoneApiOptions) {}

  private base(extra: Record<string, string> = {}): Record<string, string> {
    return { Origin: originOf(this.o.host), ...extra };
  }

  private async send(req: { url: string; method: string; headers: Record<string, string>; body?: string }): Promise<HttpResult> {
    try {
      return await this.o.http.request(req);
    } catch (e) {
      throw new ApiError(e instanceof Error && e.message ? e.message : "Sem rede.", { kind: "network" });
    }
  }

  private login(): Promise<string> {
    this.loginInFlight ??= (async () => {
      try {
        const password = await this.o.getPassword();
        if (!password) throw new ApiError("Falta a senha do celular.", { kind: "auth" });
        const r = await this.send({
          url: urlFor(this.o.host, "/api/phone/login"),
          method: "POST",
          headers: this.base({ "Content-Type": "application/json" }),
          body: JSON.stringify({ password }),
        });
        if (r.status !== 200) {
          if (r.status === 503) throw new ApiError("O computador está desconectado do servidor.", { status: 503 });
          throw errorFrom(r, "Não deu para entrar");
        }
        const cookie = parseSessionCookie(r.headers["set-cookie"]);
        if (!cookie) throw new ApiError("O servidor não devolveu a sessão.", { status: r.status });
        this.cookie = cookie;
        return cookie;
      } finally {
        this.loginInFlight = null;
      }
    })();
    return this.loginInFlight;
  }

  /** Testa a senha guardada; usado na tela de configuração. */
  async checkLogin(): Promise<void> {
    this.cookie = null;
    await this.login();
  }

  /** Pedido com sessão: entra se preciso e, no 401, entra de novo uma vez. */
  private async authed(run: (cookie: string) => Promise<HttpResult>): Promise<HttpResult> {
    const cookie = this.cookie ?? (await this.login());
    let r = await run(cookie);
    if (r.status === 401) {
      this.cookie = null;
      r = await run(await this.login());
    }
    return r;
  }

  async transcribe(fileUri: string, seconds: number): Promise<string> {
    const r = await this.authed(async (cookie) => {
      try {
        return await this.o.http.uploadFile({
          url: urlFor(this.o.host, "/api/voice/transcribe"),
          fileUri,
          headers: this.base({ Cookie: `${COOKIE_NAME}=${cookie}`, "Content-Type": "audio/mp4", "X-Audio-Ms": String(Math.round(seconds * 1000)) }),
        });
      } catch (e) {
        throw new ApiError(e instanceof Error && e.message ? e.message : "Sem rede.", { kind: "network" });
      }
    });
    if (r.status !== 200) throw errorFrom(r, "O PC não transcreveu");
    try {
      const j = JSON.parse(r.body) as { text?: unknown };
      return typeof j.text === "string" ? j.text : "";
    } catch {
      throw new ApiError("Resposta inesperada do PC.", { status: r.status });
    }
  }

  private json(method: string, path: string, body?: unknown): Promise<HttpResult> {
    return this.authed((cookie) =>
      this.send({
        url: urlFor(this.o.host, path),
        method,
        headers: this.base({ Cookie: `${COOKIE_NAME}=${cookie}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }),
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  }

  /** O usuário já confirmou que o áudio vai para o PC? */
  async privacyAcked(): Promise<boolean> {
    const r = await this.json("GET", "/api/voice");
    if (r.status !== 200) throw errorFrom(r, "Não deu para ler a voz do PC");
    try {
      return (JSON.parse(r.body) as { settings?: { privacy_ack?: boolean } }).settings?.privacy_ack === true;
    } catch {
      return false;
    }
  }

  async ackPrivacy(): Promise<void> {
    const r = await this.json("POST", "/api/voice/settings", { privacy_ack: true });
    if (r.status !== 200) throw errorFrom(r, "Não deu para gravar a confirmação");
  }
}
