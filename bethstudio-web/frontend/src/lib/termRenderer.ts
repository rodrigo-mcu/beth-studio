// Qual renderizador o xterm usa em cada terminal: WebGL (rapido, usa a GPU) ou
// DOM (o padrao do xterm 6; um elemento HTML por celula, pesado em PC fraco).
//
// A escolha e' pura e testavel aqui; o carregamento do addon fica em
// termWebgl.ts (so' navegador).

export type RendererPref = "auto" | "webgl" | "dom";
export type RendererMode = "webgl" | "dom";

export const RENDERER_KEY = "bethstudio.renderer";
/** "full" = escreve a tela inteira a cada quadro (desliga a escrita so' das linhas alteradas). */
export const WRITE_KEY = "bethstudio.screenwrite";

export function readIncrementalWrite(): boolean {
  try {
    return window.localStorage.getItem(WRITE_KEY) !== "full";
  } catch {
    return true;
  }
}

/**
 * Teto de terminais com WebGL ao mesmo tempo. O Chromium perde o contexto mais
 * antigo depois de ~16; ficar bem abaixo evita perda em cascata com muitos splits.
 * Quem passa do teto usa DOM.
 */
export const MAX_GL_PANES = 8;

export function parseRendererPref(v: unknown): RendererPref {
  return v === "webgl" || v === "dom" ? v : "auto";
}

export function readRendererPref(): RendererPref {
  try {
    return parseRendererPref(window.localStorage.getItem(RENDERER_KEY));
  } catch {
    return "auto";
  }
}

export function writeRendererPref(p: RendererPref): void {
  try {
    if (p === "auto") window.localStorage.removeItem(RENDERER_KEY);
    else window.localStorage.setItem(RENDERER_KEY, p);
  } catch {
    /* sem armazenamento: vale so' ate' recarregar */
  }
}

/** WebGL emulado na CPU (SwiftShader, llvmpipe, Basic Render Driver...): nao ajuda. */
export function isSoftwareGl(renderer: string): boolean {
  return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
}

export interface GlProbe {
  webgl2: boolean;
  /** UNMASKED_RENDERER_WEBGL, quando o navegador informa. */
  renderer: string;
}

export function chooseRenderer(pref: RendererPref, probe: GlProbe, liveGl: number, max = MAX_GL_PANES): RendererMode {
  if (pref === "dom") return "dom";
  if (!probe.webgl2) return "dom";
  if (liveGl >= max) return "dom";
  if (pref === "webgl") return "webgl";
  return isSoftwareGl(probe.renderer) ? "dom" : "webgl";
}

/**
 * Opcoes do xterm por modo. minimumContrastRatio fica em 3 nos dois: ele evita
 * texto invisivel (ex.: negrito branco em tema claro). So' o piscar do cursor
 * sai no DOM, onde cada repintura mexe em elementos HTML.
 */
export const MODE_OPTIONS: Record<RendererMode, { minimumContrastRatio: number; cursorBlink: boolean }> = {
  webgl: { minimumContrastRatio: 3, cursorBlink: true },
  dom: { minimumContrastRatio: 3, cursorBlink: false },
};

let cached: GlProbe | null = null;

/** Testa WebGL2 uma vez por pagina (navegador). */
export function probeGl(): GlProbe {
  if (cached) return cached;
  let probe: GlProbe = { webgl2: false, renderer: "" };
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? "") : "";
      probe = { webgl2: true, renderer };
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    /* sem WebGL */
  }
  cached = probe;
  return probe;
}
