// Paleta escura (a mesma do bethstudio-web, tailwind.config.ts).
export const C = {
  bgBody: "#0F1729",
  bgPanel: "#131D33",
  bgCard: "#18233C",
  bgHover: "#1F2B47",
  bgTerm: "#0B1220",
  text1: "#E5E7EB",
  text2: "#98A0B3",
  text3: "#5B6478",
  border: "#243150",
  borderStrong: "#34436A",
  accent: "#2B6CB0",
  accentPressed: "#1E5A99",
  accentSoft: "#1A3150",
  accentText: "#93C5FD",
  ok: "#6EE7B7",
  err: "#FCA5A5",
  warn: "#D97706",
  busy: "#93C5FD",
} as const;

/** Cores do xterm (DEFAULT_TERM_THEME do bethstudio-web). */
export const XTERM_THEME = {
  background: "#0B1220",
  foreground: "#E5E7EB",
  cursor: "#93C5FD",
  cursorAccent: "#0B1220",
  selectionBackground: "#2B6CB088",
  black: "#1F2937",
  red: "#F87171",
  green: "#34D399",
  yellow: "#FBBF24",
  blue: "#60A5FA",
  magenta: "#C084FC",
  cyan: "#22D3EE",
  white: "#E5E7EB",
  brightBlack: "#6B7280",
  brightRed: "#FCA5A5",
  brightGreen: "#6EE7B7",
  brightYellow: "#FDE68A",
  brightBlue: "#93C5FD",
  brightMagenta: "#D8B4FE",
  brightCyan: "#67E8F9",
  brightWhite: "#F9FAFB",
} as const;

/** Area de toque minima (Material 48dp / Apple 44pt). */
export const TOUCH = 48;
