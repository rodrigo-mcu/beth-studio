// Endereco do servidor. Trocar o transporte (ws em LAN de desenvolvimento,
// wss com TLS no modo remoto) e' so' trocar a URL: o resto do app nao muda.

export interface ServerEndpoint {
  /** URL do WebSocket, sempre com caminho (padrao /ws) e sem query string. */
  wsUrl: string;
  /** Origin enviado no handshake (o bethstudio-web recusa WS sem Origin). */
  origin: string;
  secure: boolean;
  host: string;
  port: number | null;
}

const SCHEMES: Record<string, { ws: string; http: string; secure: boolean }> = {
  "ws:": { ws: "ws:", http: "http:", secure: false },
  "http:": { ws: "ws:", http: "http:", secure: false },
  "wss:": { ws: "wss:", http: "https:", secure: true },
  "https:": { ws: "wss:", http: "https:", secure: true },
};

/**
 * Aceita `ws://h:p/ws`, `wss://h/ws`, `http://h:p`, `https://h` ou `h:p`
 * e devolve o endpoint WS. O token NUNCA vai na URL: `?t=` e' descartado.
 */
export function parseServerUrl(input: string): ServerEndpoint {
  let s = input.trim();
  if (!s) throw new Error("Informe o endereço do servidor.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `ws://${s}`;
  const m = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]+)([^?#]*)/i.exec(s);
  if (!m) throw new Error("Endereço inválido.");
  const scheme = SCHEMES[m[1]!.toLowerCase()];
  if (!scheme) throw new Error("Use ws://, wss://, http:// ou https://.");
  const authority = m[2]!;
  if (authority.includes("@")) throw new Error("Não coloque usuário/senha no endereço.");
  const hp = /^(\[[0-9a-f:.]+\]|[^:]+)(?::(\d{1,5}))?$/i.exec(authority);
  if (!hp) throw new Error("Endereço inválido.");
  const host = hp[1]!.toLowerCase();
  const port = hp[2] ? Number(hp[2]) : null;
  if (port !== null && (port < 1 || port > 65535)) throw new Error("Porta inválida.");
  let path = m[3] || "";
  if (path === "" || path === "/") path = "/ws";
  const hostPort = port !== null ? `${host}:${port}` : host;
  return {
    wsUrl: `${scheme.ws}//${hostPort}${path}`,
    origin: `${scheme.http}//${hostPort}`,
    secure: scheme.secure,
    host,
    port,
  };
}

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "[::1]" || /^127\./.test(host);
}

/** RFC 1918 + CGNAT (100.64/10, usado pelo Tailscale) + link-local. */
export function isPrivateHost(host: string): boolean {
  if (isLoopbackHost(host)) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return host.endsWith(".local") || host.endsWith(".ts.net");
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

/** Aviso para a tela de conexao (null = nada a dizer). */
export function transportWarning(ep: ServerEndpoint): string | null {
  if (ep.secure) return null;
  if (isLoopbackHost(ep.host)) return null;
  if (isPrivateHost(ep.host)) return "Conexão sem criptografia (ws://). Use só na sua rede ou em VPN.";
  return "Conexão sem criptografia para um endereço público. Qualquer um no caminho pode ler e digitar nos seus terminais. Use wss://.";
}
