// Endereço do servidor do celular: só o domínio (o app fala HTTPS/WSS e mais nada).

export type DomainResult = { ok: true; host: string } | { ok: false; error: string };

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function normalizeDomain(input: string): DomainResult {
  let s = input.trim();
  if (!s) return { ok: false, error: "Digite o endereço do servidor." };
  const scheme = /^([a-z][a-z0-9+.-]*):(\/\/)?/i.exec(s);
  if (scheme) {
    const name = (scheme[1] ?? "").toLowerCase();
    if (name === "http") return { ok: false, error: "O app só fala HTTPS. Use https:// ou só o domínio." };
    // "host:porta" parece um esquema; só é esquema de verdade com "//" ou com letras que não são host.
    if (name !== "https") {
      if (scheme[2] || !/^[a-z0-9.-]+:\d+/i.test(s)) return { ok: false, error: "Digite só o domínio, sem esquema." };
    } else {
      s = s.slice(scheme[0].length);
    }
  }
  s = s.split(/[/?#]/)[0] ?? "";
  s = s.replace(/\.+$/, "").toLowerCase();
  if (!s || /[\s@]/.test(s)) return { ok: false, error: "Endereço inválido." };

  let host = s;
  const colon = s.lastIndexOf(":");
  if (colon >= 0) {
    host = s.slice(0, colon);
    const port = s.slice(colon + 1);
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      return { ok: false, error: "Porta inválida." };
    }
  }
  if (IPV4.test(host)) return { ok: false, error: "Use o domínio (com certificado), não o número IP." };
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) {
    return { ok: false, error: "Endereço inválido. Exemplo: beth.suaempresa.com.br" };
  }
  return { ok: true, host: s };
}

export function originOf(host: string): string {
  return `https://${host}`;
}

export function urlFor(host: string, path: string): string {
  return `${originOf(host)}${path}`;
}
