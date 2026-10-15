import { test } from "node:test";
import assert from "node:assert/strict";
import { contrast, deriveUI, ensureContrast, MIN_CONTRAST, normalizeUIMode, over, STUDIO_LIGHT_TERM_THEME, studioTermTheme, VSCODE_DARK, withVisibleCursor, type ThemeLike, type UIColors } from "../src/lib/uiTheme.ts";
import type { XtermColors } from "../src/lib/types.ts";

const ansi = {
  blue: "#0070dd",
  brightBlue: "#63b2ff",
  green: "#00b050",
  brightGreen: "#00e26e",
  red: "#cd3131",
  brightRed: "#ff6363",
  yellow: "#e5e510",
  brightYellow: "#fff477",
};

function checkContrast(c: UIColors, name: string) {
  const body = c["bg-body"];
  assert.ok(contrast(c["text-1"], body) >= MIN_CONTRAST.text1, `${name}: text-1 ${contrast(c["text-1"], body).toFixed(2)}`);
  assert.ok(contrast(c["text-2"], body) >= MIN_CONTRAST.text2, `${name}: text-2`);
  assert.ok(contrast(c["text-3"], body) >= MIN_CONTRAST.text3, `${name}: text-3`);
  assert.ok(contrast(c["accent-text"], c["bg-panel"]) >= MIN_CONTRAST.accentText, `${name}: accent-text`);
  assert.ok(contrast("#ffffff", c.accent) >= MIN_CONTRAST.onAccent, `${name}: texto branco no botao`);
  for (const k of ["ok", "err", "warn", "busy"] as const) assert.ok(contrast(c[k], body) >= MIN_CONTRAST.status, `${name}: ${k}`);
}

test("tema do VS Code: usa as chaves do workbench", () => {
  const darkModern: ThemeLike = {
    dark: true,
    colors: { background: "#181818", foreground: "#cccccc", ...ansi },
    ui: {
      "sideBar.background": "#181818",
      "sideBar.foreground": "#CCCCCC",
      "sideBar.border": "#2B2B2B",
      "menu.background": "#1F1F1F",
      "list.hoverBackground": "#FFFFFF1A",
      "button.background": "#0078D4",
      "focusBorder": "#0078D4",
      "descriptionForeground": "#9D9D9D",
      "list.activeSelectionBackground": "#04395E",
    },
  };
  const c = deriveUI(darkModern);
  assert.equal(c.dark, true);
  assert.equal(c["bg-body"], "#181818");
  assert.equal(c["bg-panel"], "#181818");
  assert.equal(c["bg-card"], "#1f1f1f");
  assert.equal(c.border, "#2b2b2b");
  assert.equal(c.accent, "#0078d4");
  assert.equal(c["accent-soft"], "#04395e");
  // hover com alfa composto sobre o painel
  assert.equal(c["bg-hover"], over("#FFFFFF1A", "#181818"));
  checkContrast(c, "Dark Modern");
});

test("tema Gogh (claro): deriva de fundo/texto/ANSI e garante contraste", () => {
  const solarizedLight: ThemeLike = {
    dark: false,
    colors: {
      background: "#fdf6e3",
      foreground: "#657b83",
      blue: "#268bd2",
      brightBlue: "#839496",
      green: "#859900",
      brightGreen: "#586e75",
      red: "#dc322f",
      brightRed: "#cb4b16",
      yellow: "#b58900",
      brightYellow: "#657b83",
    },
  };
  const c = deriveUI(solarizedLight);
  assert.equal(c.dark, false);
  assert.equal(c["bg-term"], "#fdf6e3");
  // #657b83 sobre o fundo nao chega a 7:1 => foi escurecido
  assert.notEqual(c["text-1"], "#657b83");
  checkContrast(c, "Solarized Light");
});

test("tema ilegivel (texto quase igual ao fundo) e' corrigido", () => {
  const bad: ThemeLike = { dark: true, colors: { background: "#202020", foreground: "#262626", ...ansi, blue: "#9ad0ff" } };
  const c = deriveUI(bad);
  checkContrast(c, "ilegivel");
});

test("ensureContrast", () => {
  assert.equal(ensureContrast("#ffffff", "#000000", 7), "#ffffff");
  const x = ensureContrast("#777777", "#808080", 4.5);
  assert.ok(contrast(x, "#808080") >= 4.5);
});

test("Escuro = VS Code Dark Modern, sem fundo azul-marinho", () => {
  const c = VSCODE_DARK;
  assert.equal(c["bg-body"], "#181818");
  assert.equal(c["bg-panel"], "#181818");
  assert.equal(c["bg-card"], "#1f1f1f");
  assert.equal(c["bg-hover"], "#2a2d2e");
  assert.equal(c.border, "#2b2b2b");
  assert.equal(c.accent, "#0078d4");
  for (const k of ["bg-body", "bg-panel", "bg-card", "bg-hover", "bg-term", "accent-soft"] as const) {
    const h = c[k].replace("#", "");
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    assert.ok(b - Math.max(r, g) < 12, `${k} ${c[k]} puxa para o azul`);
  }
  checkContrast(c, "Escuro");
  assert.equal(normalizeUIMode("old-dark"), "dark"); // modo com prefixo de versao anterior
  assert.equal(normalizeUIMode(undefined), "dark");
  assert.equal(normalizeUIMode("old-blue"), "navy");
  assert.equal(normalizeUIMode("old-light"), "light");
  assert.equal(normalizeUIMode("navy"), "navy");
});

test("terminal novo segue o tema do Beth Studio", () => {
  assert.equal(studioTermTheme(undefined), "");
  assert.equal(studioTermTheme({ mode: "dark" }), "");
  assert.equal(studioTermTheme({ mode: "navy" }), "");
  assert.equal(studioTermTheme({ mode: "follow" }), "");
  assert.equal(studioTermTheme({ mode: "light" }), STUDIO_LIGHT_TERM_THEME);
  assert.equal(studioTermTheme({ mode: "theme", theme_id: "apple-system-colors-light" }), "apple-system-colors-light");
});

test("cursor do terminal: sem contraste com o fundo vira legível; com contraste não muda", () => {
  const claro = { background: "#FFFFFF", foreground: "#333333", cursor: "#AEAFAD" } as XtermColors;
  const v = withVisibleCursor(claro);
  assert.ok(contrast(v.cursor, v.background) >= 4.5, v.cursor);
  assert.equal(v.cursorAccent, "#FFFFFF");
  const escuro = { background: "#1E1E1E", foreground: "#D4D4D4", cursor: "#AEAFAD", cursorAccent: "#1E1E1E" } as XtermColors;
  assert.equal(withVisibleCursor(escuro), escuro);
  const semCursor = { background: "#FFFFFF", foreground: "#222222", cursor: "" } as XtermColors;
  assert.ok(contrast(withVisibleCursor(semCursor).cursor, "#FFFFFF") >= 4.5);
});
