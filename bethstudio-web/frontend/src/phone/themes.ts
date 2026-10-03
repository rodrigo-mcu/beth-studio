// Temas extras do celular. Automático, Claro e Escuro ficam no phone.css;
// estes só trocam as mesmas variáveis de cor. Sem React: o teste lê direto.

export interface PhoneColors {
  bg: string;
  surface: string;
  surface2: string;
  line: string;
  ink: string;
  muted: string;
  faint: string;
  brand: string;
  brandInk: string;
  brandPress: string;
  wait: string;
  rec: string;
  ok: string;
  termBg: string;
  termInk: string;
  focus: string;
  dark: boolean;
}

export interface PhoneThemeDef {
  id: string;
  label: string;
  colors: PhoneColors;
}

export const EXTRA_THEMES: PhoneThemeDef[] = [
  {
    id: "grafite",
    label: "Grafite",
    colors: {
      bg: "#1b1d21",
      surface: "#25282e",
      surface2: "#30343b",
      line: "#3a3f47",
      ink: "#eceff3",
      muted: "#a3a9b3",
      faint: "#7f858f",
      brand: "#5b9cf5",
      brandInk: "#0e1520",
      brandPress: "#4a89e0",
      wait: "#f2b544",
      rec: "#e5484d",
      ok: "#4cc38a",
      termBg: "#141619",
      termInk: "#e2e5ea",
      focus: "#8cc2ff",
      dark: true,
    },
  },
  {
    id: "nord",
    label: "Nord",
    colors: {
      bg: "#2e3440",
      surface: "#3b4252",
      surface2: "#434c5e",
      line: "#4c566a",
      ink: "#eceff4",
      muted: "#c0c7d4",
      faint: "#96a0b3",
      brand: "#88c0d0",
      brandInk: "#2e3440",
      brandPress: "#6fa9ba",
      wait: "#ebcb8b",
      rec: "#d9727b",
      ok: "#a3be8c",
      termBg: "#242933",
      termInk: "#e5e9f0",
      focus: "#88c0d0",
      dark: true,
    },
  },
  {
    id: "dracula",
    label: "Dracula",
    colors: {
      bg: "#282a36",
      surface: "#343746",
      surface2: "#414458",
      line: "#4d5066",
      ink: "#f8f8f2",
      muted: "#bcbfd1",
      faint: "#9094ad",
      brand: "#bd93f9",
      brandInk: "#1e1f29",
      brandPress: "#a77bf0",
      wait: "#f1fa8c",
      rec: "#ff5555",
      ok: "#50fa7b",
      termBg: "#21222c",
      termInk: "#f8f8f2",
      focus: "#ff79c6",
      dark: true,
    },
  },
  {
    id: "solarized-dark",
    label: "Solarized escuro",
    colors: {
      bg: "#002b36",
      surface: "#073642",
      surface2: "#0d4452",
      line: "#1b5261",
      ink: "#eee8d5",
      muted: "#a3b0b0",
      faint: "#839496",
      brand: "#3a9ae0",
      brandInk: "#002b36",
      brandPress: "#2a86c8",
      wait: "#d9a400",
      rec: "#ea5a57",
      ok: "#95ab00",
      termBg: "#00212b",
      termInk: "#eee8d5",
      focus: "#2aa198",
      dark: true,
    },
  },
  {
    id: "solarized-light",
    label: "Solarized claro",
    colors: {
      bg: "#fdf6e3",
      surface: "#fffbef",
      surface2: "#eee8d5",
      line: "#ddd6c1",
      ink: "#073642",
      muted: "#4f646b",
      faint: "#7b8c8e",
      brand: "#1a6aa6",
      brandInk: "#ffffff",
      brandPress: "#155688",
      wait: "#8a6d00",
      rec: "#c02a27",
      ok: "#5f6f00",
      termBg: "#fdf6e3",
      termInk: "#073642",
      focus: "#268bd2",
      dark: false,
    },
  },
  {
    id: "contraste",
    label: "Alto contraste",
    colors: {
      bg: "#000000",
      surface: "#0d0d0d",
      surface2: "#1f1f1f",
      line: "#6b6b6b",
      ink: "#ffffff",
      muted: "#d6d6d6",
      faint: "#b0b0b0",
      brand: "#ffd400",
      brandInk: "#000000",
      brandPress: "#e6bf00",
      wait: "#ffd400",
      rec: "#d42a30",
      ok: "#5dff9b",
      termBg: "#000000",
      termInk: "#ffffff",
      focus: "#ffd400",
      dark: true,
    },
  },
];

export function findTheme(id: string | null | undefined): PhoneThemeDef | undefined {
  return EXTRA_THEMES.find((t) => t.id === id);
}

function soft(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Variáveis CSS do tema (os mesmos nomes do phone.css). */
export function themeVars(c: PhoneColors): Record<string, string> {
  return {
    "--bg": c.bg,
    "--surface": c.surface,
    "--surface-2": c.surface2,
    "--line": c.line,
    "--ink": c.ink,
    "--muted": c.muted,
    "--faint": c.faint,
    "--brand": c.brand,
    "--brand-ink": c.brandInk,
    "--brand-press": c.brandPress,
    "--wait": c.wait,
    "--wait-soft": soft(c.wait, c.dark ? 0.14 : 0.2),
    "--rec": c.rec,
    "--rec-soft": soft(c.rec, c.dark ? 0.16 : 0.12),
    "--ok": c.ok,
    "--term-bg": c.termBg,
    "--term-ink": c.termInk,
    "--focus": c.focus,
    "color-scheme": c.dark ? "dark" : "light",
  };
}
