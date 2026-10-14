// Caminho de arquivo local detectado na saida de um terminal (texto ou
// imagem): deteccao/resolucao do caminho por tipo de pane. A leitura em si
// e' GET /api/local-file (localfile.go, que valida tudo de novo no Go — o
// que roda aqui e' so' para decidir se vale a pena tentar e montar o
// caminho certo). Funcoes puras, testadas em tests/localFile.test.ts.
import { apiBase } from "./remote.ts";

export const TEXT_FILE_EXT = [".md", ".markdown", ".txt", ".log"] as const;
export const IMAGE_FILE_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"] as const;

export type LocalFileKind = "text" | "image";

/** Extensao permitida (texto ou imagem)? So' olha o final do nome, sem tocar no disco. */
export function localFileKind(path: string): LocalFileKind | null {
  const low = path.toLowerCase();
  if (TEXT_FILE_EXT.some((e) => low.endsWith(e))) return "text";
  if (IMAGE_FILE_EXT.some((e) => low.endsWith(e))) return "image";
  return null;
}

/** URL do /api/local-file para este caminho (relativa: mesma origem da página). */
export function localFileURL(path: string): string {
  return `${apiBase()}/api/local-file?path=${encodeURIComponent(path)}`;
}

export function isWindowsAbsolutePath(s: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(s);
}

/** UNC "\\servidor\share\..." (inclui "\\wsl$\..." e "\\wsl.localhost\..."). */
export function isUncPath(s: string): boolean {
  return /^\\\\[^\\]/.test(s);
}

/** POSIX absoluto de verdade: uma barra so' no começo (não "//", que é UNC-like). */
export function isPosixAbsolutePath(s: string): boolean {
  return s.startsWith("/") && !s.startsWith("//");
}

/** Tem esquema ("vscode:", "http:"...)? Uma letra seguida de ":" e' unidade do Windows, nao esquema. */
export function hasScheme(s: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]+:/.test(s);
}

/** "/C:/x" ou "/mnt/c/x" -> "C:\x" (convenções que aparecem depois de tirar o "file://"). */
export function windowsDriveInPosixForm(s: string): string | null {
  const drive = /^\/([A-Za-z]):(\/.*)?$/.exec(s);
  if (drive) return `${drive[1].toUpperCase()}:${(drive[2] ?? "\\").replace(/\//g, "\\")}`;
  // /mnt/<UMA letra>/... e' a unidade do Windows montada pelo WSL; qualquer
  // outro /mnt/<nome>/ (disco montado so' no Linux) fica no WSL.
  const mnt = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(s);
  if (mnt) return `${mnt[1].toUpperCase()}:${(mnt[2] ?? "\\").replace(/\//g, "\\")}`;
  return null;
}

/** "\\wsl.localhost\<distro>\<resto, com \ no lugar de />" (o Go tenta "\\wsl$\..." se esse falhar). */
export function wslUncPath(distro: string, posixPath: string): string {
  const rest = posixPath.replace(/^\/+/, "").replace(/\//g, "\\");
  return `\\\\wsl.localhost\\${distro}\\${rest}`;
}

/** Distro de um caminho UNC do WSL ("\\wsl$\Ubuntu\..." ou "\\wsl.localhost\Ubuntu\..."). */
export function distroFromWslUnc(p: string): string | null {
  const m = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)/i.exec(p);
  return m ? m[1] : null;
}

/**
 * Tira o "file://host" de uma URI (cwd do pane, ou alvo de um hyperlink
 * OSC 8), decodificando %XX. O host e' ignorado (o nome da maquina, do WSL
 * ou "localhost" — tudo local), exceto "wsl$"/"wsl.localhost", que viram o
 * caminho UNC do WSL.
 */
export function stripFileScheme(uri: string): string {
  if (!/^file:\/\//i.test(uri)) return uri;
  const rest = uri.slice("file://".length);
  const i = rest.indexOf("/");
  const host = i >= 0 ? rest.slice(0, i) : rest;
  let path = i >= 0 ? rest.slice(i) : "";
  try {
    path = decodeURIComponent(path);
  } catch {
    /* mantem como veio */
  }
  if (/^wsl(\$|\.localhost)$/i.test(host)) return `\\\\wsl.localhost${path.replace(/\//g, "\\")}`;
  return path;
}

export interface PaneLinkCtx {
  /** "wsl" | "powershell" | ... (o mesmo kind de lib/kinds.ts) */
  paneKind?: string;
  /** o Go ja' decidiu que o pane roda no WSL (panekind.go: kind wsl, ou agente com cwd Linux) */
  paneWsl?: boolean;
  paneDistro?: string;
  /** cwd do pane, no formato "file://host/caminho" (o mesmo que vem do host) */
  paneCwd?: string;
}

/**
 * O pane roda no WSL? Pela marca do Go, pelo kind, ou pelo cwd: caminho
 * Linux (não "/C:/...") ou UNC do WSL. Um agente (Claude Code) rodando no
 * WSL entra aqui mesmo sem kind "wsl".
 */
export function paneIsWsl(ctx: PaneLinkCtx): boolean {
  if (ctx.paneWsl || ctx.paneKind === "wsl") return true;
  if (ctx.paneKind === "ssh" || ctx.paneKind === "serial" || ctx.paneKind === "gitbash" || ctx.paneKind === "mobaxterm") return false;
  const cwd = ctx.paneCwd ? stripFileScheme(ctx.paneCwd) : "";
  if (!cwd) return false;
  if (distroFromWslUnc(cwd)) return true;
  return isPosixAbsolutePath(cwd) && !windowsDriveInPosixForm(cwd);
}

/** Distro do WSL do pane: a informada, ou a do cwd UNC. Nunca inventa uma. */
export function paneWslDistro(ctx: PaneLinkCtx): string | null {
  if (ctx.paneDistro) return ctx.paneDistro;
  const cwd = ctx.paneCwd ? stripFileScheme(ctx.paneCwd) : "";
  return cwd ? distroFromWslUnc(cwd) : null;
}

/**
 * Resolve um candidato (de um hyperlink OSC 8, ou de texto solto) para um
 * caminho local ABSOLUTO pronto para /api/local-file, ou null quando não dá
 * para saber com segurança (evita falso positivo em vez de adivinhar).
 */
export function resolveLinkPath(raw: string, ctx: PaneLinkCtx): string | null {
  const candidate = stripFileScheme(raw.trim());
  if (!candidate) return null;
  // "~" e "~/..." ficam para o Go expandir (os.UserHomeDir). Colar no cwd
  // viraria "D:\docs\~\..." e abriria o arquivo errado.
  if (candidate === "~" || /^~[\\/]/.test(candidate)) {
    const rest = candidate.slice(1).replace(/^[\\/]+/, "").replace(/\//g, "\\");
    return rest ? `~\\${rest}` : "~";
  }
  if (isWindowsAbsolutePath(candidate)) return candidate.replace(/\//g, "\\");
  if (isUncPath(candidate)) return candidate;
  if (hasScheme(candidate)) return null; // vscode:, mailto:... nunca e' arquivo
  const win = windowsDriveInPosixForm(candidate);
  if (win) return win;
  if (isPosixAbsolutePath(candidate)) {
    if (!paneIsWsl(ctx)) return null; // so' resolvivel com segurança num pane WSL
    const distro = paneWslDistro(ctx);
    return distro ? wslUncPath(distro, candidate) : null;
  }
  // relativo: so' resolve se o cwd do pane for claro
  const base = ctx.paneCwd ? resolveLinkPath(ctx.paneCwd, ctx) : null;
  if (!base) return null;
  return `${base.replace(/[\\/]+$/, "")}\\${candidate.replace(/^\.[\\/]/, "").replace(/\//g, "\\")}`;
}
