import { useSyncExternalStore } from "react";
import type { Connection } from "./connection";
import type { Appearance, FontInfo, FontPreset, SettingsEvent, ThemeInfo, XtermColors } from "./types";
import { studioTermTheme } from "./uiTheme";

// Catalogo de temas e fontes (vem do Go: as mesmas fontes de dados da GUI) e
// as acoes que gravam em web-settings.json / theme-favorites.json.

/** Padrao de fabrica: o mesmo da GUI (padrao do WezTerm) e do VS Code do usuario. */
export const FALLBACK_FAMILY = "JetBrains Mono";

/**
 * Padrao de fabrica do web (quando nem o terminal nem o "Tema padrao" do web
 * tem tema) e tambem o que aparece enquanto o catalogo carrega: VS Code Dark
 * neutro, sem azul (ANSI = vscode_dark da GUI, selecao cinza).
 */
export const FACTORY_THEME_NAME = "VS Code Dark (padrão do web)";
export const DEFAULT_TERM_THEME: XtermColors = {
  background: "#1E1E1E",
  foreground: "#D4D4D4",
  cursor: "#AEAFAD",
  cursorAccent: "#1E1E1E",
  selectionBackground: "#3A3D41",
  selectionForeground: "#FFFFFF",
  black: "#000000",
  red: "#CD3131",
  green: "#00B050",
  yellow: "#E5E510",
  blue: "#0070DD",
  magenta: "#BC3FBC",
  cyan: "#00B0F0",
  white: "#D4D4D4",
  brightBlack: "#808080",
  brightRed: "#FF6363",
  brightGreen: "#00E26E",
  brightYellow: "#FFF477",
  brightBlue: "#63B2FF",
  brightMagenta: "#FF77FF",
  brightCyan: "#63D7FF",
  brightWhite: "#FFFFFF",
}

export interface Catalog {
  themes: ThemeInfo[] | null;
  themeById: Map<string, ThemeInfo>;
  fonts: FontInfo[] | null;
  presets: FontPreset[];
  error: string | null;
}

let catalog: Catalog = { themes: null, themeById: new Map(), fonts: null, presets: [], error: null };
const listeners = new Set<() => void>();
let loading = false;

function set(p: Partial<Catalog>) {
  catalog = { ...catalog, ...p };
  listeners.forEach((fn) => fn());
}

export async function loadCatalog(conn: Connection, reload = false, attempt = 0): Promise<void> {
  if (loading) return;
  loading = true;
  const q = reload ? "?reload=1" : "";
  // Cada parte carrega sozinha: uma falha (ex.: fontes) nao deixa os temas
  // sem carregar; o que falhou tenta de novo com espera crescente.
  const [t, f, s] = await Promise.allSettled([
    conn.api<{ themes: ThemeInfo[] }>(`/api/themes${q}`),
    conn.api<{ fonts: FontInfo[]; presets: FontPreset[] }>(`/api/fonts${q}`),
    conn.api<SettingsEvent>("/api/settings"),
  ]);
  loading = false;
  const patch: Partial<Catalog> = { error: null };
  if (t.status === "fulfilled") {
    patch.themes = t.value.themes;
    patch.themeById = new Map(t.value.themes.map((x) => [x.id, x]));
  }
  if (f.status === "fulfilled") {
    patch.fonts = f.value.fonts;
    patch.presets = f.value.presets ?? [];
  }
  if (s.status === "fulfilled") conn.setSettings(s.value);
  const failed = [t, f, s].find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  if (failed) {
    patch.error = failed.reason instanceof Error ? failed.reason.message : String(failed.reason);
    if (attempt < 6) window.setTimeout(() => void loadCatalog(conn, false, attempt + 1), 1000 * 2 ** attempt);
  }
  set(patch);
}

export function useCatalog(): Catalog {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => catalog,
  );
}

export interface Effective {
  themeId: string; // "" = tema embutido
  family: string;
  size: number; // 0 = automatico
  /** true quando o valor vem da configuracao do proprio terminal */
  paneTheme: boolean;
  /** negrito efetivo (pane -> padrao do web -> font_bold da GUI) */
  bold: boolean;
  paneBold: boolean;
  paneFont: boolean;
  paneSize: boolean;
}

export function effectiveFor(settings: SettingsEvent | null, paneId: number): Effective {
  const pane = settings?.panes?.[String(paneId)];
  const def = settings?.default ?? {};
  return {
    // Ordem: tema do proprio terminal > "Tema padrao dos terminais" > tema
    // da interface do Beth Studio (studioTermTheme) > fabrica (VS Code Dark).
    // Assim um terminal ou SSH novo nasce com o tema do Studio e so' muda se
    // o usuario escolher outro nele. O padrao da GUI (default-theme.json) NAO
    // e' herdado aqui; Aparencia geral oferece "usar o padrao da GUI".
    themeId: pane?.theme || def.theme || studioTermTheme(settings?.ui_theme),
    family: pane?.font_family || def.font_family || settings?.gui_default_font || FALLBACK_FAMILY,
    size: pane?.font_size || def.font_size || 0,
    paneTheme: !!pane?.theme,
    bold: pane?.font_bold ?? def.font_bold ?? settings?.gui_default_bold ?? false,
    paneBold: pane?.font_bold !== undefined,
    paneFont: !!pane?.font_family,
    paneSize: !!pane?.font_size,
  };
}

export function colorsFor(cat: Catalog, themeId: string): XtermColors {
  return (themeId && cat.themeById.get(themeId)?.colors) || DEFAULT_TERM_THEME;
}

/** Lista de familias CSS com fallback monoespacado. */
export function cssFamily(family: string): string {
  const f = family.replace(/["\\]/g, "");
  return `"${f}", "JetBrains Mono", "Cascadia Mono", Consolas, monospace`;
}

// --- acoes -------------------------------------------------------------

function paneAppearance(settings: SettingsEvent | null, paneId: number): Appearance {
  const p = settings?.panes?.[String(paneId)];
  return {
    theme: p?.theme ?? "",
    font_family: p?.font_family ?? "",
    font_size: p?.font_size ?? 0,
    size_mode: p?.size_mode ?? "",
    font_bold: p?.font_bold,
  };
}

export async function setPane(conn: Connection, paneId: number, patch: Appearance) {
  const cur = paneAppearance(conn.getSnapshot().settings, paneId);
  const s = await conn.api<SettingsEvent>("/api/settings/pane", { pane_id: paneId, ...cur, ...patch });
  conn.setSettings(s);
}

export async function setDefault(conn: Connection, patch: Appearance) {
  const d = conn.getSnapshot().settings?.default ?? {};
  const s = await conn.api<SettingsEvent>("/api/settings/default", {
    theme: d.theme ?? "",
    font_family: d.font_family ?? "",
    font_size: d.font_size ?? 0,
    // o servidor troca o padrao inteiro: preserva o que nao mudou
    ...(d.size_mode ? { size_mode: d.size_mode } : {}),
    ...(d.font_bold !== undefined ? { font_bold: d.font_bold } : {}),
    ...patch,
  });
  conn.setSettings(s);
}

export async function setThemeFavorite(conn: Connection, id: string, favorite: boolean) {
  conn.setSettings(await conn.api<SettingsEvent>("/api/favorites/theme", { id, favorite }));
}

export async function setFontFavorite(conn: Connection, family: string, favorite: boolean) {
  conn.setSettings(await conn.api<SettingsEvent>("/api/favorites/font", { family, favorite }));
}

const availCache = new Map<string, boolean>();

/**
 * A familia existe no WebView2? (document.fonts.check diz "sim" para
 * fontes locais inexistentes, entao mede: com a fonte, a largura muda em
 * relacao ao generico monospace ou serif.)
 */
export function fontAvailable(family: string): boolean {
  const f = family.trim();
  if (!f) return false;
  const hit = availCache.get(f);
  if (hit !== undefined) return hit;
  let ok = true;
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) {
      const probe = "mmmmmmmmmmlli0O@#WWwi";
      const w = (font: string) => {
        ctx.font = font;
        return ctx.measureText(probe).width;
      };
      const q = f.replace(/"/g, "");
      ok = w(`32px "${q}", monospace`) !== w("32px monospace") || w(`32px "${q}", serif`) !== w("32px serif");
    }
  } catch {
    ok = true;
  }
  availCache.set(f, ok);
  return ok;
}

/** Familia que sera' usada de fato (a escolhida, ou a padrao se faltar). */
export function resolveFamily(family: string): { used: string; missing: boolean } {
  if (fontAvailable(family)) return { used: family, missing: false };
  if (family !== FALLBACK_FAMILY && fontAvailable(FALLBACK_FAMILY)) return { used: FALLBACK_FAMILY, missing: true };
  return { used: "Consolas", missing: true };
}
