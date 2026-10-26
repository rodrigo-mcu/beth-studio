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

function applyMode(term: Terminal, mode: RendererMode) {
  const o = MODE_OPTIONS[mode];
  term.options.minimumContrastRatio = o.minimumContrastRatio;
  term.options.cursorBlink = o.cursorBlink;
  // so' para diagnostico/teste: qual renderizador esta' valendo neste terminal
  term.element?.setAttribute("data-renderer", mode);
}

/** Chamar DEPOIS de term.open(). Comeca em DOM e troca para WebGL quando o addon carrega. */
export function attachRenderer(term: Terminal): RendererHandle {
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
    if (!disposed) applyMode(term, "dom");
  };

  applyMode(term, "dom");
  if (chooseRenderer(readRendererPref(), probeGl(), liveGl) === "webgl") {
    holdsSlot = true;
    liveGl++;
    import("@xterm/addon-webgl")
      .then(({ WebglAddon }) => {
        if (disposed) return release();
        try {
          const a = new WebglAddon();
          a.onContextLoss(() => fallback("contexto perdido"));
          term.loadAddon(a);
          addon = a;
          mode = "webgl";
          applyMode(term, "webgl");
        } catch (e) {
          fallback(e instanceof Error ? e.message : "erro ao iniciar");
        }
      })
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
