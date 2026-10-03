// ipc.ts — the bridge between the React UI and the Rust host.
//
// Send: `window.ipc.postMessage(JSON.stringify(req))` (wry's IPC).
// Receive: the Rust side calls `window.__wtinator_reply(jsonString)`
// via `evaluate_script`. We register a single global callback that
// resolves the pending request promise.
//
// The wire types mirror the Rust `wtinator::notify` model
// (ThemeSnapshot / TabSnapshot) plus a couple of fields the host
// adds for the UI (connected / notice).

export type ThemeKind = "BuiltIn" | "UserDownloaded";

export interface ThemeSnapshot {
  id: string;
  name: string;
  kind: ThemeKind;
  ansi: string[]; // 16 hex colors
  foreground: string;
  background: string;
  cursor: string;
  selection_fg: string;
  selection_bg: string;
  preview_text: string;
}

export interface TabSnapshot {
  tab_id: number;
  tab_index: number;
  title: string;
  group_name: string | null;
  current_theme: string;
  active_pane_id: number;
  // Patch 0043: the font family override on this tab's active pane
  // (null = the window font). Used to pre-select the family picker.
  active_pane_font_family?: string | null;
}

// Patch 0131: the visual state one live terminal already has.
export interface PaneSnapshot {
  pane_id: number;
  tab_id: number;
  theme_id: string | null;
  font_family: string | null;
  font_scale: number;
  font_bold: boolean;
  font_italic: boolean;
}

export interface Snapshot {
  type: "snapshot";
  connected: boolean;
  wezterm_pid: number;
  notice: string;
  tabs: TabSnapshot[];
  themes: ThemeSnapshot[];
  protocol_version: number;
  // Patch 0040: non-null when launched from a terminal's right-click
  // menu (`--pane-id`). When set, the UI runs in "pane mode": it
  // configures just that one terminal (theme + exact font size).
  pane_id: number | null;
  // Patch 0040: the window's base font size (points). Used as the
  // initial value of the per-pane size control.
  base_font_size: number;
  // Patch 0110: persisted default theme for new terminals (null if unset).
  default_theme?: string | null;
  // Patch 0131: per-pane visual state, keyed by pane_id.
  panes?: PaneSnapshot[];
}

export interface SetThemeResult {
  type: "set_theme_result";
  ok: boolean;
  tab_id: number;
  theme: string;
  error: string | null;
}

// Patch 0040: reply to a `set_pane_theme` request (per-terminal theme).
export interface SetPaneThemeResult {
  type: "set_pane_theme_result";
  ok: boolean;
  pane_id: number;
  theme: string;
  error: string | null;
}

// Patch 0040: reply to a `set_pane_font_size` request (per-terminal
// absolute font size in points).
export interface SetPaneFontSizeResult {
  type: "set_pane_font_size_result";
  ok: boolean;
  pane_id: number;
  size: number;
  error: string | null;
}

// Patch 0043: reply to a `set_pane_font_family` request (per-terminal
// typeface). `family` is null when the override was cleared.
export interface SetPaneFontFamilyResult {
  type: "set_pane_font_family_result";
  ok: boolean;
  pane_id: number;
  family: string | null;
  error: string | null;
}

// Patch 0047: reply to a `set_pane_font_style` request (bold / italic).
export interface SetPaneFontStyleResult {
  type: "set_pane_font_style_result";
  ok: boolean;
  pane_id: number;
  bold: boolean;
  italic: boolean;
  error: string | null;
}

// Patch 0043: reply to a `list_fonts` request — the font family names
// the connected terminal can load (empty in standalone mode).
export interface ListFontsResult {
  type: "list_fonts_result";
  fonts: string[];
  error: string | null;
}

// Patch 0038: reply to a `download_themes` request. `count` is the
// number of themes written to `%APPDATA%\wezterminator\themes\`.
export interface DownloadThemesResult {
  type: "download_themes_result";
  ok: boolean;
  count: number;
  source?: "network" | "bundled" | null;
  error: string | null;
}

// Patch 0062 (refined): a favourite is a PRESET — a theme id plus the font
// TYPE to apply with it: family + bold/italic. NOT the size — the size stays
// per-terminal. fontFamily "" means the window default; an omitted field means
// "leave unchanged" when applying. Shape owned by the frontend; the host stores
// the array opaquely.
export interface FavoritePreset {
  id: string;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
}

// Patch 0060/0062: persisted favourites, returned by `get_favorites`. Items may
// also be legacy plain theme-id strings (pre-preset); the UI normalises those.
export interface FavoritesReply {
  type: "favorites";
  items: (FavoritePreset | string)[];
}

// Patch 0060: reply to a `save_favorites` request.
export interface SaveFavoritesResult {
  type: "save_favorites_result";
  ok: boolean;
  error: string | null;
}

// Patch 0110: reply to a `set_default_theme` request (persist + apply-all).
export interface SetDefaultThemeResult {
  type: "set_default_theme_result";
  ok: boolean;
  theme: string;
  error: string | null;
}

export interface ErrorReply {
  type: "error";
  error: string;
}

export type Reply =
  | Snapshot
  | SetThemeResult
  | SetPaneThemeResult
  | SetPaneFontSizeResult
  | SetPaneFontFamilyResult
  | SetPaneFontStyleResult
  | ListFontsResult
  | DownloadThemesResult
  | FavoritesReply
  | SaveFavoritesResult
  | SetDefaultThemeResult
  | ErrorReply;

// wry injects `window.ipc.postMessage`.
declare global {
  interface Window {
    ipc?: { postMessage: (msg: string) => void };
    __wtinator_reply?: (json: string) => void;
  }
}

// Single-flight request queue. The host replies in order, so we keep
// a FIFO of pending resolvers.
const pending: Array<(reply: Reply) => void> = [];

window.__wtinator_reply = (json: string) => {
  let reply: Reply;
  try {
    reply = JSON.parse(json) as Reply;
  } catch (e) {
    reply = { type: "error", error: "failed to parse host reply: " + e };
  }
  const resolve = pending.shift();
  if (resolve) resolve(reply);
};

function send(req: object): Promise<Reply> {
  return new Promise((resolve) => {
    pending.push(resolve);
    const msg = JSON.stringify(req);
    if (window.ipc && window.ipc.postMessage) {
      window.ipc.postMessage(msg);
    } else {
      // Running in a plain browser (vite dev / preview) with no host.
      // Resolve with a demo snapshot so the UI is still developable.
      pending.pop();
      resolve(demoReply(req));
    }
  });
}

export function listTabs(): Promise<Reply> {
  return send({ type: "list_tabs" });
}

export function setTheme(tabId: number, theme: string): Promise<Reply> {
  return send({ type: "set_theme", tab_id: tabId, theme });
}

// Patch 0040: apply a theme to one specific pane (the right-clicked
// terminal), not a tab's active pane.
export function setPaneTheme(paneId: number, theme: string): Promise<Reply> {
  return send({ type: "set_pane_theme", pane_id: paneId, theme });
}

// Patch 0040: set an absolute font size (points) on one specific pane.
export function setPaneFontSize(
  paneId: number,
  size: number,
): Promise<Reply> {
  return send({ type: "set_pane_font_size", pane_id: paneId, size });
}

// Patch 0043: set the font family (typeface) on one specific pane.
// Pass `null` to clear the override (back to the window font).
export function setPaneFontFamily(
  paneId: number,
  family: string | null,
): Promise<Reply> {
  return send({ type: "set_pane_font_family", pane_id: paneId, family });
}

// Patch 0047: set bold / italic on one specific pane.
export function setPaneFontStyle(
  paneId: number,
  bold: boolean,
  italic: boolean,
): Promise<Reply> {
  return send({ type: "set_pane_font_style", pane_id: paneId, bold, italic });
}

// Patch 0043: list the font families the connected terminal can load.
export function listFonts(): Promise<Reply> {
  return send({ type: "list_fonts" });
}

// Patch 0038: ask the host to download the Gogh community theme
// catalog. The host caches each theme on disk and replies with a
// `download_themes_result`; the UI then re-issues `listTabs()` to
// pick up the new cards.
export function downloadThemes(): Promise<Reply> {
  return send({ type: "download_themes" });
}

// Patch 0060: load / save the favourite theme ids from the host's on-disk
// store (replaces the old localStorage, which the WebView wiped each time the
// config window was reopened).
export function getFavorites(): Promise<Reply> {
  return send({ type: "get_favorites" });
}

export function saveFavorites(items: FavoritePreset[]): Promise<Reply> {
  return send({ type: "save_favorites", items });
}

// Patch 0110: persist this theme as the default for every terminal and
// apply it to all live panes.
// Patch 0132: the default also carries the font (family, size in points,
// bold, italic) so new terminals open with it.
export interface DefaultFont {
  font_family: string | null;
  font_size: number | null;
  font_bold: boolean;
  font_italic: boolean;
}

export function setDefaultTheme(
  theme: string,
  font?: DefaultFont,
): Promise<Reply> {
  return send({ type: "set_default_theme", theme, ...(font ?? {}) });
}

// ---- demo data for browser-only development (no Rust host) --------

function demoTheme(
  id: string,
  name: string,
  bg: string,
  fg: string,
  ansi: string[],
): ThemeSnapshot {
  return {
    id,
    name,
    kind: "BuiltIn",
    ansi,
    foreground: fg,
    background: bg,
    cursor: fg,
    selection_fg: "#ffffff",
    selection_bg: "#264f78",
    preview_text:
      'fn main() {\n    println!("\\x1b[31mred\\x1b[0m \\x1b[32mgreen\\x1b[0m");\n}',
  };
}

function demoReply(req: object): Reply {
  const r = req as {
    type?: string;
    tab_id?: number;
    pane_id?: number;
    theme?: string;
    size?: number;
    family?: string | null;
    bold?: boolean;
    italic?: boolean;
    items?: unknown[];
  };
  if (r.type === "set_theme") {
    return {
      type: "set_theme_result",
      ok: true,
      tab_id: r.tab_id ?? 0,
      theme: r.theme ?? "",
      error: null,
    };
  }
  if (r.type === "set_pane_theme") {
    return {
      type: "set_pane_theme_result",
      ok: true,
      pane_id: r.pane_id ?? 0,
      theme: r.theme ?? "",
      error: null,
    };
  }
  if (r.type === "set_pane_font_size") {
    return {
      type: "set_pane_font_size_result",
      ok: true,
      pane_id: r.pane_id ?? 0,
      size: r.size ?? 0,
      error: null,
    };
  }
  if (r.type === "set_pane_font_family") {
    return {
      type: "set_pane_font_family_result",
      ok: true,
      pane_id: r.pane_id ?? 0,
      family: r.family ?? null,
      error: null,
    };
  }
  if (r.type === "set_pane_font_style") {
    return {
      type: "set_pane_font_style_result",
      ok: true,
      pane_id: r.pane_id ?? 0,
      bold: r.bold ?? false,
      italic: r.italic ?? false,
      error: null,
    };
  }
  if (r.type === "list_fonts") {
    // Demo mode: a handful of common monospace families so the picker
    // is developable in a plain browser.
    return {
      type: "list_fonts_result",
      fonts: [
        "Cascadia Code",
        "Consolas",
        "Fira Code",
        "JetBrains Mono",
        "Iosevka",
      ],
      error: null,
    };
  }
  if (r.type === "download_themes") {
    // Demo mode: pretend we downloaded a handful of themes.
    return {
      type: "download_themes_result",
      ok: true,
      count: 0,
      error: null,
    };
  }
  if (r.type === "get_favorites") {
    // Browser-only dev: fall back to localStorage so the ★ presets are still
    // developable without a Rust host.
    try {
      const items = JSON.parse(localStorage.getItem("wt_favorite_themes") || "[]");
      return { type: "favorites", items };
    } catch {
      return { type: "favorites", items: [] };
    }
  }
  if (r.type === "save_favorites") {
    try {
      localStorage.setItem("wt_favorite_themes", JSON.stringify(r.items ?? []));
    } catch {
      /* ignore */
    }
    return { type: "save_favorites_result", ok: true, error: null };
  }
  if (r.type === "set_default_theme") {
    try {
      localStorage.setItem("wt_default_theme", r.theme ?? "");
    } catch {
      /* ignore */
    }
    return {
      type: "set_default_theme_result",
      ok: true,
      theme: r.theme ?? "",
      error: null,
    };
  }
  const darkAnsi = [
    "#000000", "#cd3131", "#00b050", "#e5e510", "#0070dd", "#bc3fbc",
    "#00b0f0", "#d4d4d4", "#808080", "#ff6363", "#00e26e", "#fff477",
    "#63b2ff", "#ff77ff", "#63d7ff", "#ffffff",
  ];
  const lightAnsi = [
    "#000000", "#cd3131", "#008000", "#b8860b", "#264f78", "#800080",
    "#008080", "#555555", "#808080", "#f14c4c", "#00c800", "#e5b567",
    "#569cd6", "#c86ec8", "#00bcbc", "#b4b4b4",
  ];
  return {
    type: "snapshot",
    connected: false,
    wezterm_pid: 0,
    notice: "Demo mode (no terminal host).",
    protocol_version: 1,
    // Patch 0040: demo "pane mode" so the per-terminal UI (theme +
    // size control) is developable in a plain browser. Set to `null`
    // here to preview the legacy tab-based UI instead.
    pane_id: 1,
    base_font_size: 12,
    default_theme: "vscode_dark",
    tabs: [
      {
        tab_id: 1,
        tab_index: 0,
        title: "pwsh",
        group_name: "work",
        current_theme: "vscode_dark",
        active_pane_id: 1,
      },
      {
        tab_id: 2,
        tab_index: 1,
        title: "bash",
        group_name: null,
        current_theme: "default",
        active_pane_id: 2,
      },
    ],
    themes: [
      demoTheme("vscode_dark", "VSCode Dark", "#1e1e1e", "#d4d4d4", darkAnsi),
      demoTheme("vscode_light", "VSCode Light", "#ffffff", "#1f1f1f", lightAnsi),
      demoTheme(
        "windows_terminal_dark",
        "Windows Terminal Dark",
        "#0c0c0c",
        "#cccccc",
        darkAnsi,
      ),
    ],
  };
}
