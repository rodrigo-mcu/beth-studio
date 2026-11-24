/** Combinação gravada, no formato "mod+f" ou "ctrl+shift+k". */
export type Shortcut = string;

const isMac = () => typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/** Padrão da busca: Command+F no macOS, Ctrl+F no Windows. */
export function defaultSearchShortcut(): Shortcut {
  return isMac() ? "meta+f" : "ctrl+f";
}

export function shortcutParts(s: Shortcut): string[] {
  return (s || defaultSearchShortcut()).split("+").map((p) => {
    if (p === "meta" || p === "mod") return isMac() ? "⌘" : "Ctrl";
    if (p === "ctrl") return isMac() ? "⌃" : "Ctrl";
    if (p === "alt") return isMac() ? "⌥" : "Alt";
    if (p === "shift") return isMac() ? "⇧" : "Shift";
    if (p === "arrowright") return "→";
    if (p === "arrowleft") return "←";
    if (p === "arrowup") return "↑";
    if (p === "arrowdown") return "↓";
    return p.length === 1 ? p.toUpperCase() : p;
  });
}

export function shortcutLabel(s: Shortcut): string {
  return shortcutParts(s).join(isMac() ? "" : "+");
}

/** A tecla bate na combinação. "mod" é Command no macOS e Ctrl no Windows. */
export function eventMatches(e: KeyboardEvent, s: Shortcut): boolean {
  const want = new Set((s || defaultSearchShortcut()).split("+"));
  const mod = want.has("mod") ? (isMac() ? e.metaKey : e.ctrlKey) : true;
  const ctrl = want.has("ctrl") ? e.ctrlKey : !e.ctrlKey || want.has("mod");
  const meta = want.has("meta") ? e.metaKey : !e.metaKey || (want.has("mod") && isMac());
  const alt = want.has("alt") ? e.altKey : !e.altKey;
  const shift = want.has("shift") ? e.shiftKey : !e.shiftKey;
  const key = [...want].find((p) => !["mod", "ctrl", "meta", "alt", "shift"].includes(p)) ?? "";
  if (!mod || !ctrl || !meta || !alt || !shift) return false;
  return e.key.toLowerCase() === key.toLowerCase();
}

/** Lê a próxima tecla pressionada e devolve a combinação, ou "" para limpar. */
export function captureShortcut(e: KeyboardEvent): Shortcut | null {
  if (e.key === "Escape") return "";
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.metaKey) parts.push("meta");
  else if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  parts.push(key);
  return parts.join("+");
}

/** Atalhos da página. O valor gravado substitui o padrão. */
export interface ShortcutDef {
  id: string;
  label: string;
  def: () => Shortcut;
}

export function shortcutCatalog(): ShortcutDef[] {
  const mac = isMac();
  const mod = (key: string) => (mac ? `meta+${key}` : `ctrl+${key}`);
  return [
    { id: "search", label: "Focar a busca", def: defaultSearchShortcut },
    { id: "new_tab", label: "Nova aba", def: () => mod("t") },
    { id: "close_tab", label: "Fechar a aba", def: () => mod("w") },
    { id: "next_tab", label: "Próxima aba", def: () => (mac ? "meta+alt+ArrowRight" : "ctrl+Tab") },
    { id: "prev_tab", label: "Aba anterior", def: () => (mac ? "meta+alt+ArrowLeft" : "ctrl+shift+Tab") },
    { id: "settings", label: "Abrir configurações", def: () => mod(",") },
  ];
}

export function shortcutOf(saved: Record<string, string> | undefined, id: string): Shortcut {
  const item = shortcutCatalog().find((s) => s.id === id);
  return (saved && saved[id]) || item?.def() || "";
}
