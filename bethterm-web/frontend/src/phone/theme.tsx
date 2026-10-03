import { useState } from "react";
import { EXTRA_THEMES, findTheme, themeVars } from "./themes";

// Tema do app no celular: Automático, Claro, Escuro ou um dos temas extras
// (themes.ts). Fica só neste aparelho.

/** "auto" | "light" | "dark" | id de um tema extra */
export type PhoneTheme = string;
const KEY = "bethphone.theme";
// Variáveis que um tema extra põe no style do <html>; saem ao trocar.
let inlineVars: string[] = [];

export function loadTheme(): PhoneTheme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || findTheme(v)) return v as string;
  } catch {
    /* sem storage */
  }
  return "auto";
}

export function applyTheme(t: PhoneTheme) {
  const root = document.documentElement;
  const extra = findTheme(t);
  for (const k of inlineVars) root.style.removeProperty(k);
  inlineVars = [];
  if (extra) {
    for (const [k, v] of Object.entries(themeVars(extra.colors))) {
      root.style.setProperty(k, v);
      inlineVars.push(k);
    }
  }
  if (t === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
  // Barra do sistema acompanha a escolha.
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    m.dataset.media ??= m.media;
    m.dataset.content ??= m.content;
    if (t === "auto") {
      m.media = m.dataset.media;
      m.content = m.dataset.content;
    } else {
      m.media = "all";
      m.content = extra ? extra.colors.bg : t === "dark" ? "#14203a" : "#eef2f9";
    }
  });
}

function saveTheme(t: PhoneTheme) {
  try {
    if (t === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    /* sem storage */
  }
  applyTheme(t);
}

const OPTIONS: { id: PhoneTheme; label: string }[] = [
  { id: "auto", label: "Automático" },
  { id: "light", label: "Claro" },
  { id: "dark", label: "Escuro" },
];

/** Escolha do tema, para os menus da lista e do terminal. */
export function ThemePicker() {
  const [t, setT] = useState(loadTheme);
  return (
    <>
      <div className="p-menu__hint">Tema</div>
      <div className="p-seg" role="group" aria-label="Tema">
        {OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            aria-pressed={t === o.id}
            onClick={() => {
              setT(o.id);
              saveTheme(o.id);
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
      <div className="p-themes" role="group" aria-label="Mais temas">
        {EXTRA_THEMES.map((o) => (
          <button
            key={o.id}
            type="button"
            aria-pressed={t === o.id}
            onClick={() => {
              setT(o.id);
              saveTheme(o.id);
            }}
          >
            <span className="p-themes__swatch" aria-hidden="true" style={{ background: o.colors.bg, borderColor: o.colors.line }}>
              <span style={{ background: o.colors.brand }} />
            </span>
            {o.label}
          </button>
        ))}
      </div>
    </>
  );
}
