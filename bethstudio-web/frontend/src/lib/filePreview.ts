// Lógica pura do painel de preview de arquivo local (FilePreviewPanel):
// o que "Copiar tudo" copia, como um link/imagem relativo dentro de um .md
// vira um caminho local, e as preferências por visualizador (fonte, zoom,
// tamanho do painel). Testado em tests/filePreview.test.ts.
import {
  distroFromWslUnc,
  hasScheme,
  isUncPath,
  isWindowsAbsolutePath,
  stripFileScheme,
  windowsDriveInPosixForm,
} from "./localFile.ts";

export type PreviewView = "rendered" | "source";

/**
 * "Copiar tudo": SEMPRE o conteúdo cru do arquivo (o fonte do Markdown),
 * nunca o HTML renderizado — mesmo com a visão "renderizado" ligada.
 */
export function copyAllText(doc: { raw: string }, _view: PreviewView): string {
  return doc.raw;
}

/** Raiz e segmentos de um caminho absoluto do Windows ("C:" / "\\srv\share"). */
function splitRoot(p: string): { root: string; segs: string[] } | null {
  const s = p.replace(/\//g, "\\");
  const drive = /^([A-Za-z]:)(?:\\(.*))?$/.exec(s);
  if (drive) return { root: drive[1].toUpperCase(), segs: (drive[2] ?? "").split("\\") };
  const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/.exec(s);
  if (unc) return { root: `\\\\${unc[1]}\\${unc[2]}`, segs: (unc[3] ?? "").split("\\") };
  return null;
}

function joinNormalized(root: string, segs: string[]): string | null {
  const out: string[] = [];
  for (const s of segs) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (!out.length) return null; // acima da raiz: recusa
      out.pop();
    } else out.push(s);
  }
  if (!out.length) return null;
  return `${root}\\${out.join("\\")}`;
}

/**
 * Link ou imagem dentro de um documento local (`filePath`, já absoluto:
 * "C:\..." ou "\\wsl.localhost\<distro>\...") -> caminho local absoluto,
 * sem ".." (o Go valida de novo), ou null se não for arquivo local
 * (http, âncora, outro esquema, caminho ambíguo).
 */
export function resolveDocLink(href: string, filePath: string): string | null {
  let h = href.trim();
  if (!h || h.startsWith("#")) return null;
  if (/^https?:/i.test(h)) return null;
  h = h.replace(/[?#].*$/, "");
  if (/^file:\/\//i.test(h)) h = stripFileScheme(h);
  else {
    try {
      h = decodeURIComponent(h);
    } catch {
      /* mantem */
    }
  }
  if (!h) return null;
  const base = splitRoot(filePath);
  if (!base) return null;
  if (isWindowsAbsolutePath(h) || isUncPath(h)) {
    const r = splitRoot(h);
    return r ? joinNormalized(r.root, r.segs) : null;
  }
  if (hasScheme(h)) return null;
  if (h.startsWith("/")) {
    // absoluto Linux: so' faz sentido num documento que esta' no WSL
    const distro = distroFromWslUnc(filePath);
    if (!distro) return null;
    const win = windowsDriveInPosixForm(h);
    if (win) {
      const r = splitRoot(win);
      return r ? joinNormalized(r.root, r.segs) : null;
    }
    return joinNormalized(base.root, h.split("/"));
  }
  // relativo: contra a pasta do documento
  return joinNormalized(base.root, [...base.segs.slice(0, -1), ...h.split(/[\\/]/)]);
}

/** Nome do arquivo (último segmento). */
export function fileBaseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export const FONT_MIN = 9;
export const FONT_MAX = 28;
export const FONT_DEFAULT = 13;

export function stepFont(size: number, delta: number): number {
  return Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(size) + delta));
}

/** Zoom de imagem: degraus fixos; "fit" é à parte (0). */
export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

export function stepZoom(zoom: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((z) => z > zoom + 1e-6) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((z) => z < zoom - 1e-6) ?? ZOOM_STEPS[0];
}

// --- preferências por visualizador (localStorage; pode faltar) ------------

export function loadPref<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    const v: unknown = JSON.parse(raw);
    return valid(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* sem armazenamento: so' nesta sessao */
  }
}

// --- editor ----------------------------------------------------------------
// O <textarea> troca "\r\n" por "\n" sozinho; ao salvar, o texto volta ao
// fim de linha que o arquivo tinha (um .md do Windows continua CRLF).

export type Eol = "\r\n" | "\n";

export function detectEol(raw: string): Eol {
  return raw.includes("\r\n") ? "\r\n" : "\n";
}

export function editableText(raw: string): string {
  return raw.replace(/\r\n/g, "\n");
}

export function toDiskText(text: string, eol: Eol): string {
  const lf = text.replace(/\r\n/g, "\n");
  return eol === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf;
}
