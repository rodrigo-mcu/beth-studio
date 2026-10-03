import type { Config } from "tailwindcss";

// Paleta da interface: cores como variaveis CSS (fundo, texto, acento e os
// acentos semanticos ok/err/warn/busy), trocadas em tempo real.
const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      // Cores da interface = variaveis CSS (lib/uiTheme.ts troca o tema em
      // tempo real: Escuro/Claro/Azul-marinho, seguir o tema dos terminais...).
      colors: {
        bg: {
          body: "rgb(var(--bt-bg-body) / <alpha-value>)",
          panel: "rgb(var(--bt-bg-panel) / <alpha-value>)",
          card: "rgb(var(--bt-bg-card) / <alpha-value>)",
          hover: "rgb(var(--bt-bg-hover) / <alpha-value>)",
          term: "rgb(var(--bt-bg-term) / <alpha-value>)",
        },
        text: {
          1: "rgb(var(--bt-text-1) / <alpha-value>)",
          2: "rgb(var(--bt-text-2) / <alpha-value>)",
          3: "rgb(var(--bt-text-3) / <alpha-value>)",
        },
        border: {
          DEFAULT: "rgb(var(--bt-border) / <alpha-value>)",
          strong: "rgb(var(--bt-border-strong) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--bt-accent) / <alpha-value>)",
          hover: "rgb(var(--bt-accent-hover) / <alpha-value>)",
          soft: "rgb(var(--bt-accent-soft) / <alpha-value>)",
          text: "rgb(var(--bt-accent-text) / <alpha-value>)",
        },
        status: {
          ok: "rgb(var(--bt-ok) / <alpha-value>)",
          err: "rgb(var(--bt-err) / <alpha-value>)",
          warn: "rgb(var(--bt-warn) / <alpha-value>)",
          busy: "rgb(var(--bt-busy) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ["Segoe UI", "system-ui", "sans-serif"],
        mono: ["Cascadia Mono", "Consolas", "ui-monospace", "monospace"],
      },
      keyframes: {
        "bt-flash": {
          "0%, 100%": { boxShadow: "0 0 0 0 rgba(43,108,176,0)" },
          "50%": { boxShadow: "0 0 0 4px rgba(147,197,253,0.9)" },
        },
        "led-pulse": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.45", transform: "scale(0.92)" },
        },
      },
      animation: {
        "bt-flash": "bt-flash 0.42s ease-in-out 3",
        "led-pulse": "led-pulse 1.1s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
