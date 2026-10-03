// Tema da INTERFACE (o "shell" do app: barra lateral, abas, cabecalhos,
// menus, busca, paineis). Cores aplicadas como variaveis CSS no :root
// (tailwind.config.ts usa rgb(var(--bt-...) / <alpha-value>)).
//
// Funcoes puras (testadas em tests/uiTheme.test.ts), exceto applyUI().

export type UIToken =
  | "bg-body"
  | "bg-panel"
  | "bg-card"
  | "bg-hover"
  | "bg-term"
  | "text-1"
  | "text-2"
  | "text-3"
  | "border"
  | "border-strong"
  | "accent"
  | "accent-hover"
  | "accent-soft"
  | "accent-text"
  | "ok"
  | "err"
  | "warn"
  | "busy";

export type UIColors = Record<UIToken, string> & { dark: boolean };

/** "Azul-marinho": escuro com fundo navy. */
export const NAVY_DARK: UIColors = {
  dark: true,
  "bg-body": "#0F1729",
  "bg-panel": "#131D33",
  "bg-card": "#18233C",
  "bg-hover": "#1F2B47",
  "bg-term": "#161A22",
  "text-1": "#E5E7EB",
  "text-2": "#98A0B3",
  "text-3": "#5B6478",
  border: "#243150",
  "border-strong": "#34436A",
  accent: "#2B6CB0",
  "accent-hover": "#1E5A99",
  "accent-soft": "#1A3150",
  "accent-text": "#93C5FD",
  ok: "#6EE7B7",
  err: "#FCA5A5",
  warn: "#D97706",
  busy: "#93C5FD",
};

/** Claro. */
export const LIGHT: UIColors = {
  dark: false,
  "bg-body": "#F7F7F4",
  "bg-panel": "#FFFFFF",
  "bg-card": "#FFFFFF",
  "bg-hover": "#F1F2EE",
  "bg-term": "#FFFFFF",
  "text-1": "#0F1729",
  "text-2": "#5B6478",
  "text-3": "#98A0B3",
  border: "#E5E7EB",
  "border-strong": "#CBD0D8",
  accent: "#2B6CB0",
  "accent-hover": "#1E5A99",
  "accent-soft": "#E7F0F9",
  "accent-text": "#1E5A99",
  ok: "#059669",
  err: "#DC2626",
  warn: "#D97706",
  busy: "#2563EB",
};

// --- cor ---------------------------------------------------------------

export type RGB = [number, number, number];

export function parseColor(s: string | undefined): { rgb: RGB; a: number } | null {
  if (!s) return null;
  const h = s.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]+$/.test(h)) return null;
  const full = h.length === 3 || h.length === 4 ? h.split("").map((c) => c + c).join("") : h;
  if (full.length !== 6 && full.length !== 8) return null;
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
  return { rgb: [n(0), n(2), n(4)], a: full.length === 8 ? n(6) / 255 : 1 };
}

export function hex([r, g, b]: RGB): string {
  const c = (x: number) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function mix(a: string, b: string, k: number): string {
  const x = parseColor(a)?.rgb ?? [0, 0, 0];
  const y = parseColor(b)?.rgb ?? [0, 0, 0];
  return hex([x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k]);
}

/** Cor com alfa (#RRGGBBAA do VS Code) composta sobre um fundo. */
export function over(color: string | undefined, bg: string): string | undefined {
  const c = parseColor(color);
  if (!c) return undefined;
  return c.a >= 1 ? hex(c.rgb) : mix(bg, hex(c.rgb), c.a);
}

function lin(v: number) {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function luminance(c: string): number {
  const [r, g, b] = parseColor(c)?.rgb ?? [0, 0, 0];
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Razao de contraste WCAG (1..21). */
export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Empurra `fg` para branco ou preto ate' atingir `min` contra `bg`. */
export function ensureContrast(fg: string, bg: string, min: number): string {
  if (contrast(fg, bg) >= min) return fg;
  // vai para o extremo (preto/branco) que da' mais contraste com o fundo
  const target = contrast("#000000", bg) >= contrast("#ffffff", bg) ? "#000000" : "#ffffff";
  let c = fg;
  for (let k = 0.1; k <= 1.0001; k += 0.1) {
    c = mix(fg, target, k);
    if (contrast(c, bg) >= min) return c;
  }
  return target;
}

// --- derivacao -----------------------------------------------------------

export interface ThemeLike {
  dark: boolean;
  colors: { background: string; foreground: string; blue: string; brightBlue: string; green: string; brightGreen: string; red: string; brightRed: string; yellow: string; brightYellow: string };
  ui?: Record<string, string>;
}

/** Minimos de contraste garantidos pela derivacao. */
export const MIN_CONTRAST = { text1: 7, text2: 4.5, text3: 3, accentText: 4.5, status: 3, onAccent: 4.5 };

/**
 * Cores da interface a partir de um tema de terminal. Temas do VS Code usam
 * as chaves do workbench (sideBar.*, tab.*, focusBorder, list.*, input.*,
 * button.*...) com fallbacks; Gogh/embutidos derivam de fundo/texto/ANSI.
 */
export function deriveUI(t: ThemeLike): UIColors {
  const u = t.ui ?? {};
  const term = hex(parseColor(t.colors.background)?.rgb ?? [0, 0, 0]);
  const fgT = hex(parseColor(t.colors.foreground)?.rgb ?? [255, 255, 255]);
  const dark = luminance(term) < 0.25 ? true : luminance(term) > 0.45 ? false : t.dark;

  const body = over(u["sideBar.background"], term) ?? over(u["editorGroupHeader.tabsBackground"], term) ?? mix(term, dark ? "#000000" : "#ffffff", 0.15);
  const panel = over(u["sideBar.background"], term) ?? mix(term, fgT, 0.04);
  const card = over(u["menu.background"], term) ?? over(u["editorWidget.background"], term) ?? mix(panel, fgT, 0.07);
  const hover = over(u["list.hoverBackground"], panel) ?? mix(panel, fgT, 0.1);
  const fg0 = over(u["sideBar.foreground"], body) ?? over(u["foreground"], body) ?? fgT;
  const text1 = ensureContrast(fg0, body, MIN_CONTRAST.text1);
  const text2 = ensureContrast(over(u["descriptionForeground"], body) ?? mix(text1, body, 0.3), body, MIN_CONTRAST.text2);
  const text3 = ensureContrast(mix(text1, body, 0.5), body, MIN_CONTRAST.text3);
  const border = over(u["sideBar.border"], body) ?? over(u["panel.border"], body) ?? mix(body, text1, 0.14);
  const borderStrong = mix(body, text1, 0.26);
  let accent =
    over(u["button.background"], body) ?? over(u["focusBorder"], body) ?? (dark ? t.colors.blue : t.colors.blue);
  accent = hex(parseColor(accent)?.rgb ?? [43, 108, 176]);
  // Texto branco sobre botoes de destaque precisa ser legivel.
  const onAccentOk = contrast("#ffffff", accent) >= MIN_CONTRAST.onAccent;
  if (!onAccentOk) accent = ensureContrast(accent, "#ffffff", MIN_CONTRAST.onAccent);
  const accentHover = mix(accent, "#000000", 0.15);
  const accentSoft = over(u["list.activeSelectionBackground"], panel) ?? mix(panel, accent, dark ? 0.3 : 0.15);
  const accentText = ensureContrast(dark ? mix(accent, "#ffffff", 0.45) : accent, panel, MIN_CONTRAST.accentText);
  const st = (a: string, b: string) => ensureContrast(dark ? b : a, body, MIN_CONTRAST.status);

  return {
    dark,
    "bg-body": body,
    "bg-panel": panel,
    "bg-card": card,
    "bg-hover": hover,
    "bg-term": term,
    "text-1": text1,
    "text-2": text2,
    "text-3": text3,
    border,
    "border-strong": borderStrong,
    accent,
    "accent-hover": accentHover,
    "accent-soft": accentSoft,
    "accent-text": accentText,
    ok: st(t.colors.green, t.colors.brightGreen),
    err: st(t.colors.red, t.colors.brightRed),
    warn: st(t.colors.yellow, t.colors.brightYellow),
    busy: st(t.colors.blue, t.colors.brightBlue),
  };
}

const TOKENS: UIToken[] = Object.keys(NAVY_DARK).filter((k) => k !== "dark") as UIToken[];

/** Variaveis no formato do cache do Go (token -> "r g b") + fundo. */
export function uiCSSPayload(c: UIColors): { vars: Record<string, string>; bg: string } {
  const vars: Record<string, string> = {};
  for (const k of TOKENS) {
    const p = parseColor(c[k]);
    if (p) vars[k] = `${p.rgb[0]} ${p.rgb[1]} ${p.rgb[2]}`;
  }
  return { vars, bg: hex(parseColor(c["bg-body"])?.rgb ?? [30, 30, 30]) };
}

/** Escreve as variaveis CSS no :root (formato "r g b" para o Tailwind). */
export function applyUI(c: UIColors) {
  const root = document.documentElement;
  for (const k of TOKENS) {
    const p = parseColor(c[k]);
    if (p) root.style.setProperty(`--bt-${k}`, `${p.rgb[0]} ${p.rgb[1]} ${p.rgb[2]}`);
  }
  root.classList.toggle("dark", c.dark);
  // o <style> de boot (injetado pelo Go) sai de cena: as inline valem agora
  document.getElementById("bt-boot")?.remove();
  document.body.style.background = c["bg-body"];
  root.style.colorScheme = c.dark ? "dark" : "light";
}

/** Chaves do workbench do VS Code "Dark Modern" (tema escuro padrao do VS Code). */
export const VSCODE_DARK_MODERN_UI: Record<string, string> = {
  "sideBar.background": "#181818",
  "sideBar.foreground": "#CCCCCC",
  "sideBar.border": "#2B2B2B",
  "editorGroupHeader.tabsBackground": "#181818",
  "tab.activeBackground": "#1F1F1F",
  "tab.inactiveBackground": "#181818",
  "editor.background": "#1F1F1F",
  "editor.foreground": "#CCCCCC",
  "panel.border": "#2B2B2B",
  "menu.background": "#1F1F1F",
  "list.hoverBackground": "#2A2D2E",
  "list.activeSelectionBackground": "#37373D",
  "focusBorder": "#0078D4",
  "button.background": "#0078D4",
  "button.foreground": "#FFFFFF",
  "button.hoverBackground": "#026EC1",
  "descriptionForeground": "#9D9D9D",
  "input.background": "#313131",
  "foreground": "#CCCCCC",
};

/** "Escuro" (padrao): o VS Code Dark Modern, sem fundo azul-marinho. */
export const VSCODE_DARK: UIColors = deriveUI({
  dark: true,
  colors: {
    background: "#1F1F1F",
    foreground: "#CCCCCC",
    blue: "#0070DD",
    brightBlue: "#63B2FF",
    green: "#00B050",
    brightGreen: "#00E26E",
    red: "#CD3131",
    brightRed: "#FF6363",
    yellow: "#E5E510",
    brightYellow: "#FFF477",
  },
  ui: VSCODE_DARK_MODERN_UI,
});

export type UIMode = "dark" | "light" | "navy" | "follow" | "theme";

/**
 * Modo salvo -> modo atual (nada = "dark"). Versoes anteriores gravavam os
 * modos com um prefixo ("<prefixo>-dark|-light|-blue"): viram os atuais.
 */
export function normalizeUIMode(m: string | undefined): UIMode {
  if (!m) return "dark";
  if ((["dark", "light", "navy", "follow", "theme"] as string[]).includes(m)) return m as UIMode;
  if (m.endsWith("-light")) return "light";
  if (m.endsWith("-blue")) return "navy";
  return "dark";
}

/** Tema claro dos terminais quando a interface esta' em "Claro" (built-in da GUI). */
export const STUDIO_LIGHT_TERM_THEME = "vscode_light";

/**
 * Tema que um terminal sem tema proprio (e sem "Tema padrao dos terminais")
 * usa para acompanhar o Beth Studio: o tema escolhido na interface, o claro
 * no modo Claro e o de fabrica ("") nos escuros. "follow" ja' e' a interface
 * seguindo os terminais, entao nao acrescenta nada. Espelho de
 * studioTermTheme em pane_palette.go.
 */
export function studioTermTheme(ui: { mode?: string; theme_id?: string } | null | undefined): string {
  const mode = normalizeUIMode(ui?.mode);
  if (mode === "theme") return ui?.theme_id?.trim() ?? "";
  if (mode === "light") return STUDIO_LIGHT_TERM_THEME;
  return "";
}
