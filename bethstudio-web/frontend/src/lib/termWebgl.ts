// Liga o renderizador WebGL do xterm num terminal, com volta ao DOM se algo
// falhar (sem WebGL2, perda de contexto, erro do driver). Escolha em
// termRenderer.ts.
import type { Terminal } from "@xterm/xterm";
import { MODE_OPTIONS, chooseRenderer, probeGl, readRendererPref, type RendererMode } from "./termRenderer";

export interface RendererHandle {
  mode(): RendererMode;
  /** Refaz o atlas de glifos (a fonte web terminou de carregar). */
  refreshAtlas(): void;
  dispose(): void;
}

let liveGl = 0; // terminais que seguram uma vaga de WebGL (inclui os ainda carregando)

// O addon carrega uma vez só. Trocar de aba recria o terminal: com o módulo
// já carregado, o WebGL entra na hora, sem passar pelo DOM. A troca DOM ->
// WebGL depois de aberto fazia a tela piscar e mudava o tamanho da célula
// sem reajustar (texto encolhido num canto).
type WebglModule = typeof import("@xterm/addon-webgl");
let webglMod: WebglModule | null = null;
let webglLoad: Promise<WebglModule> | null = null;
function loadWebgl(): Promise<WebglModule> {
  webglLoad ??= import("@xterm/addon-webgl").then((m) => (webglMod = m));
  return webglLoad;
}

/** Começa a baixar o addon cedo (antes do primeiro terminal), se for usar WebGL. */
export function preloadRenderer() {
  if (chooseRenderer(readRendererPref(), probeGl(), liveGl) === "webgl") void loadWebgl().catch(() => undefined);
}

function applyMode(term: Terminal, mode: RendererMode) {
  const o = MODE_OPTIONS[mode];
  term.options.minimumContrastRatio = o.minimumContrastRatio;
  term.options.cursorBlink = o.cursorBlink;
  // so' para diagnostico/teste: qual renderizador esta' valendo neste terminal
  term.element?.setAttribute("data-renderer", mode);
}

/**
 * Chamar DEPOIS de term.open(). Com o addon já carregado, liga o WebGL na
 * hora; senão começa em DOM e troca quando carregar. `onChange` roda quando
 * o renderizador troca depois de aberto (o tamanho da célula muda: reajustar).
 */
export function attachRenderer(term: Terminal, onChange?: () => void): RendererHandle {
  let mode: RendererMode = "dom";
  let holdsSlot = false;
  let disposed = false;
  let addon: { dispose(): void; clearTextureAtlas(): void } | null = null;

  const release = () => {
    if (holdsSlot) {
      holdsSlot = false;
      liveGl--;
    }
  };
  const fallback = (why: string) => {
    if (mode === "dom" && !addon) {
      release();
      return;
    }
    console.warn(`[terminal] WebGL desligado neste terminal (${why}); usando DOM`);
    try {
      addon?.dispose();
    } catch {
      /* ja' solto */
    }
    addon = null;
    release();
    mode = "dom";
    if (!disposed) {
      applyMode(term, "dom");
      onChange?.();
    }
  };

  applyMode(term, "dom");
  if (chooseRenderer(readRendererPref(), probeGl(), liveGl) === "webgl") {
    holdsSlot = true;
    liveGl++;
    const start = ({ WebglAddon }: WebglModule, late: boolean) => {
      if (disposed) return release();
      try {
        const a = new WebglAddon();
        a.onContextLoss(() => fallback("contexto perdido"));
        term.loadAddon(a);
        addon = a;
        mode = "webgl";
        applyMode(term, "webgl");
        if (late) onChange?.();
      } catch (e) {
        fallback(e instanceof Error ? e.message : "erro ao iniciar");
      }
    };
    if (webglMod) start(webglMod, false);
    else
      loadWebgl()
        .then((m) => start(m, true))
        .catch((e) => fallback(e instanceof Error ? e.message : "addon nao carregou"));
  }

  return {
    mode: () => mode,
    refreshAtlas: () => {
      try {
        addon?.clearTextureAtlas();
      } catch {
        /* sem atlas */
      }
    },
    dispose: () => {
      disposed = true;
      try {
        addon?.dispose();
      } catch {
        /* o term.dispose() tambem solta */
      }
      addon = null;
      release();
    },
  };
}
