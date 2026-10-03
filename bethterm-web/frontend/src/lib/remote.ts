// Studio remoto: a mesma página, aberta em https://<domínio>/studio/ pelo
// túnel (remote_gate.go). A API fica em /studio/api/..., o WebSocket em
// /studio/ws. O que abre algo na tela do PC não existe aqui.

export const REMOTE_BASE = "/studio";

export function isRemotePath(pathname: string): boolean {
  return pathname === REMOTE_BASE || pathname.startsWith(REMOTE_BASE + "/");
}

/** Esta página é o Studio remoto? */
export function isRemote(): boolean {
  return typeof window !== "undefined" && isRemotePath(window.location.pathname);
}

/** Prefixo das rotas do Go ("" no PC). */
export function apiBase(): string {
  return isRemote() ? REMOTE_BASE : "";
}

/** Abre Banco ou SFTP numa aba (no PC são janelas próprias). */
export function openRemoteTab(query: string) {
  window.open(`${REMOTE_BASE}/?${query}`, "_blank", "noopener");
}

/** Sai do Studio remoto (o formulário leva o cookie e volta ao login). */
export function remoteLogout() {
  const f = document.createElement("form");
  f.method = "post";
  f.action = `${REMOTE_BASE}/logout`;
  document.body.appendChild(f);
  f.submit();
}

/** Nome de arquivo seguro para download. */
export function downloadName(title: string, ext: string): string {
  const base = title.replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "beth-studio";
  return base + ext;
}

/** Baixa no computador de quem está usando (Studio remoto no lugar do "Salvar como" do PC). */
export function download(name: string, href: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** "Chrome · Windows" a partir do User-Agent (lista de sessões no PC). */
export function browserLabel(ua: string): string {
  const b = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Navegador";
  const os = /iPhone|iPad/.test(ua)
    ? "iPhone"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "Mac"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${b} · ${os}` : b;
}

/** "agora", "há 5 min", "há 3 h", "há 2 dias". */
export function sinceLabel(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 1) return "agora";
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? "há 1 dia" : `há ${d} dias`;
}
