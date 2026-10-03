import { useEffect, useMemo, useState } from "react";
import {
  downloadThemes,
  FavoritePreset,
  getFavorites,
  listTabs,
  listFonts,
  saveFavorites,
  setTheme,
  setPaneTheme,
  setPaneFontSize,
  setPaneFontFamily,
  setPaneFontStyle,
  setDefaultTheme,
  Snapshot,
  TabSnapshot,
  ThemeSnapshot,
} from "./ipc";
import { ThemeCard } from "./ThemeCard";

// Patch 0046: theme browser. How many cards to render per "page"; the
// grid grows by this as the user scrolls so the (hundreds-strong) Gogh
// catalog never renders all at once.
const THEME_PAGE = 36;

// Patch 0060/0062: favourites are persisted on disk by the host (get_favorites
// / save_favorites IPC), because the WebView's localStorage is wiped on every
// config-window spawn (the page has a null origin under `with_html`). Each
// favourite is a PRESET: a theme id plus the font (size / family / bold /
// italic) captured when it was starred, applied together when the favourite is
// applied.

// Normalise the host's favourites array into a Map keyed by theme id. Handles
// both preset objects and any legacy plain-string (pre-preset) entries.
function presetsFromItems(
  items: (FavoritePreset | string)[] | undefined,
): Map<string, FavoritePreset> {
  const map = new Map<string, FavoritePreset>();
  for (const it of items ?? []) {
    if (typeof it === "string") map.set(it, { id: it });
    else if (it && typeof it.id === "string") map.set(it.id, it);
  }
  return map;
}

// Classify a theme as light or dark from its background luminance
// (Rec. 601). Most terminal themes are dark; a near-white bg is light.
function isLightTheme(bg: string): boolean {
  const h = bg.replace("#", "").trim();
  if (h.length < 6) return false;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return false;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 >= 0.5;
}

type ThemeMode = "all" | "fav" | "light" | "dark";

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selectedTab, setSelectedTab] = useState<number | null>(null);
  const [status, setStatus] = useState<string>("Loading…");
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  // Patch 0040: which theme card is selected in pane mode (there is no
  // tab "current theme" to anchor on, so we track the user's choice).
  const [paneTheme, setPaneThemeSel] = useState<string | null>(null);
  // Patch 0040: the absolute font size shown in the size control.
  // `null` until we get the first snapshot, then seeded from the
  // window's base font size.
  const [fontSize, setFontSize] = useState<number | null>(null);
  // Patch 0043: the list of font families the host can load, and the
  // family currently chosen in the picker ("" = window default). The
  // family is seeded once from the pane's current override.
  const [fonts, setFonts] = useState<string[]>([]);
  const [fontFamily, setFontFamily] = useState<string | null>(null);
  // Patch 0047: per-terminal bold / italic.
  const [bold, setBold] = useState(false);
  const [italic, setItalic] = useState(false);
  // Patch 0046: theme browser — name search, light/dark/favorites
  // filter, progressive render count, and persisted favorites.
  const [themeSearch, setThemeSearch] = useState("");
  const [themeMode, setThemeMode] = useState<ThemeMode>("all");
  const [visibleCount, setVisibleCount] = useState(THEME_PAGE);
  const [favPresets, setFavPresets] = useState<Map<string, FavoritePreset>>(
    new Map(),
  );
  // Patch 0110: persisted default theme id (badge + "Usar em todos").
  const [defaultThemeId, setDefaultThemeId] = useState<string | null>(null);

  // Patch 0062 (refined): starring a theme saves a PRESET — the theme id plus
  // the font TYPE (family + bold/italic; NOT the size, which stays per-terminal)
  // — so applying the favourite restores the colours + type. Unstarring removes.
  function toggleFavorite(id: string) {
    setFavPresets((prev) => {
      const next = new Map(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.set(id, {
          id,
          fontFamily: fontFamily ?? "",
          bold,
          italic,
        });
      }
      void saveFavorites([...next.values()]);
      return next;
    });
  }

  // Patch 0062 (refined): refresh a favourite's saved font TYPE (family / bold
  // / italic) to this terminal's current settings — one click instead of
  // unstar+star. (The size is not part of the favourite; it stays per-terminal.)
  function updateFavoriteFont(id: string) {
    setFavPresets((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.set(id, {
        id,
        fontFamily: fontFamily ?? "",
        bold,
        italic,
      });
      void saveFavorites([...next.values()]);
      return next;
    });
    setStatus(`Saved the current font to favourite "${id}".`);
  }

  // Patch 0060/0062: load persisted favourite presets from the host on mount.
  useEffect(() => {
    let cancelled = false;
    getFavorites().then((reply) => {
      if (!cancelled && reply.type === "favorites") {
        setFavPresets(presetsFromItems(reply.items));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh() {
    const reply = await listTabs();
    if (reply.type === "snapshot") {
      setSnapshot(reply);
      // Patch 0040: seed the size control from the window's base size
      // the first time we get a snapshot (don't clobber a value the
      // user is already editing).
      // Patch 0131: the right-clicked terminal's current state. Seed
      // every control from it the first time, so reopening "Configure
      // terminal" shows the theme / family / size / bold / italic the
      // pane already has instead of blank defaults.
      const base = reply.base_font_size || 12;
      const mine =
        reply.pane_id != null
          ? (reply.panes ?? []).find((p) => p.pane_id === reply.pane_id) ?? null
          : null;
      setFontSize((cur) => {
        if (cur != null) return cur;
        const scale = mine && mine.font_scale > 0 ? mine.font_scale : 1;
        return Math.round(base * scale * 2) / 2;
      });
      if (mine) {
        setPaneThemeSel((cur) => (cur != null ? cur : mine.theme_id));
        setBold(mine.font_bold);
        setItalic(mine.font_italic);
      }
      setDefaultThemeId(reply.default_theme ?? null);
      // Patch 0043: seed the family picker from the right-clicked pane's
      // current font override the first time we connect. We find the
      // pane via its id (the host passed `--pane-id`, echoed as
      // `reply.pane_id`) among the tabs' active panes. `null` (= window
      // default) until then; `""` is the explicit "Default" choice.
      setFontFamily((cur) => {
        if (cur != null) return cur;
        if (reply.pane_id == null) return null;
        if (mine) return mine.font_family ?? "";
        const owning = reply.tabs.find(
          (t) => t.active_pane_id === reply.pane_id,
        );
        return owning?.active_pane_font_family ?? "";
      });
      setStatus(
        reply.connected
          ? `Connected to wezterm (pid ${reply.wezterm_pid})`
          : reply.notice || "Not connected to a terminal.",
      );
      // Auto-select the first tab if none chosen yet (tab mode only).
      setSelectedTab((cur) => {
        if (cur != null) return cur;
        return reply.tabs.length > 0 ? reply.tabs[0].tab_id : null;
      });
    } else if (reply.type === "error") {
      setStatus("Error: " + reply.error);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Patch 0043: fetch the available font families once. The list lives
  // on the GUI host (it owns wezterm-font); in standalone mode it comes
  // back empty and the picker offers only "Default".
  useEffect(() => {
    (async () => {
      const reply = await listFonts();
      if (reply.type === "list_fonts_result") {
        setFonts(reply.fonts);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tabs: TabSnapshot[] = snapshot?.tabs ?? [];
  const themes: ThemeSnapshot[] = snapshot?.themes ?? [];
  // Patch 0040: pane mode is active when the host passed a `--pane-id`.
  const paneId: number | null = snapshot?.pane_id ?? null;
  const paneMode = paneId != null;

  const activeTab = useMemo(
    () => tabs.find((t) => t.tab_id === selectedTab) ?? null,
    [tabs, selectedTab],
  );

  // ----- tab mode: apply a theme to the selected tab's active pane ---
  async function applyTabTheme(themeId: string) {
    if (selectedTab == null) {
      setStatus("Select a tab first.");
      return;
    }
    setBusy(true);
    const reply = await setTheme(selectedTab, themeId);
    setBusy(false);
    if (reply.type === "set_theme_result") {
      if (reply.ok) {
        setStatus(`Applied "${themeId}" to tab #${reply.tab_id}.`);
        setSnapshot((prev) =>
          prev
            ? {
                ...prev,
                tabs: prev.tabs.map((t) =>
                  t.tab_id === reply.tab_id
                    ? { ...t, current_theme: themeId }
                    : t,
                ),
              }
            : prev,
        );
      } else {
        setStatus("Failed to apply theme: " + (reply.error ?? "unknown error"));
      }
    } else if (reply.type === "error") {
      setStatus("Error: " + reply.error);
    }
  }

  // ----- pane mode: apply a theme to the one right-clicked pane ------
  async function applyPaneTheme(themeId: string) {
    if (paneId == null) return;
    setBusy(true);
    const reply = await setPaneTheme(paneId, themeId);
    setBusy(false);
    if (reply.type === "set_pane_theme_result") {
      if (reply.ok) {
        setPaneThemeSel(themeId);
        setStatus(`Applied "${themeId}" to terminal #${reply.pane_id}.`);
      } else {
        setStatus("Failed to apply theme: " + (reply.error ?? "unknown error"));
      }
    } else if (reply.type === "error") {
      setStatus("Error: " + reply.error);
    }
  }

  // Patch 0110: persist this theme as the default for every terminal and
  // recolour all live panes. New tabs pick it up automatically.
  async function applyToAll(themeId: string) {
    setBusy(true);
    // Patch 0132: the default is theme + the font shown in this window
    // (family, size, bold, italic).
    const reply = await setDefaultTheme(themeId, {
      font_family: fontFamily && fontFamily !== "" ? fontFamily : null,
      font_size: fontSize,
      font_bold: bold,
      font_italic: italic,
    });
    setBusy(false);
    if (reply.type === "set_default_theme_result") {
      if (reply.ok) {
        setDefaultThemeId(themeId);
        setPaneThemeSel(themeId);
        setSnapshot((prev) =>
          prev
            ? {
                ...prev,
                default_theme: themeId,
                tabs: prev.tabs.map((t) => ({
                  ...t,
                  current_theme: themeId,
                })),
              }
            : prev,
        );
        setStatus(
          `Tema "${themeId}" + fonte atual definidos como padrão e aplicados em todos os terminais.`,
        );
      } else {
        setStatus(
          "Falha ao definir o tema padrão: " + (reply.error ?? "unknown error"),
        );
      }
    } else if (reply.type === "error") {
      setStatus("Error: " + reply.error);
    }
  }

  // Patch 0062: applying a favourited theme also restores its saved font
  // (size / family / bold / italic) so the whole preset is applied at once.
  // A non-favourited theme applies the colours only, as before.
  async function applyTheme(themeId: string) {
    if (paneMode) {
      await applyPaneTheme(themeId);
    } else {
      await applyTabTheme(themeId);
    }
    const preset = favPresets.get(themeId);
    if (preset && paneMode) {
      // Patch 0062 (refined): apply the saved font TYPE (family + bold/italic),
      // NOT the size — the size stays whatever this terminal already has.
      if (typeof preset.fontFamily === "string")
        await commitFontFamily(preset.fontFamily);
      if (preset.bold !== undefined || preset.italic !== undefined) {
        await commitFontStyle(!!preset.bold, !!preset.italic);
      }
    }
  }

  // ----- pane mode: set the pane's absolute font size ---------------
  async function commitFontSize(value: number) {
    if (paneId == null) return;
    const clamped = Math.max(6, Math.min(48, Math.round(value)));
    setFontSize(clamped);
    setBusy(true);
    const reply = await setPaneFontSize(paneId, clamped);
    setBusy(false);
    if (reply.type === "set_pane_font_size_result") {
      if (reply.ok) {
        setStatus(`Set font size ${clamped}pt on terminal #${reply.pane_id}.`);
      } else {
        setStatus(
          "Failed to set font size: " + (reply.error ?? "unknown error"),
        );
      }
    } else if (reply.type === "error") {
      setStatus("Error: " + reply.error);
    }
  }

  // Patch 0043: set the pane's font family. An empty selection clears
  // the override (sends `null`) and returns the pane to the window font.
  async function commitFontFamily(value: string) {
    if (paneId == null) return;
    setFontFamily(value);
    setBusy(true);
    const family = value === "" ? null : value;
    const reply = await setPaneFontFamily(paneId, family);
    setBusy(false);
    if (reply.type === "set_pane_font_family_result") {
      if (reply.ok) {
        setStatus(
          family == null
            ? `Reset terminal #${reply.pane_id} to the default font.`
            : `Set font "${family}" on terminal #${reply.pane_id}.`,
        );
      } else {
        setStatus(
          "Failed to set font: " + (reply.error ?? "unknown error"),
        );
      }
    } else if (reply.type === "error") {
      setStatus("Error: " + reply.error);
    }
  }

  // Patch 0047: set bold / italic on the right-clicked pane.
  async function commitFontStyle(nextBold: boolean, nextItalic: boolean) {
    if (paneId == null) return;
    setBold(nextBold);
    setItalic(nextItalic);
    setBusy(true);
    const reply = await setPaneFontStyle(paneId, nextBold, nextItalic);
    setBusy(false);
    if (reply.type === "set_pane_font_style_result") {
      setStatus(
        reply.ok
          ? `Font style updated on terminal #${reply.pane_id}.`
          : "Failed to set font style: " + (reply.error ?? "unknown error"),
      );
    } else if (reply.type === "error") {
      setStatus("Error: " + reply.error);
    }
  }

  // Patch 0038/0099: refresh the theme catalog (network first,
  // bundled Gogh snapshot if offline).
  async function download() {
    setDownloading(true);
    setStatus("Updating theme catalog…");
    const reply = await downloadThemes();
    setDownloading(false);
    if (reply.type === "download_themes_result") {
      if (reply.ok) {
        const n = reply.count;
        const src = reply.source === "bundled" ? "bundled catalog (offline)" : "network";
        setStatus(`Installed ${n} theme${n === 1 ? "" : "s"} from the ${src}.`);
        await refresh();
      } else {
        setStatus("Update failed: " + (reply.error ?? "unknown error"));
      }
    } else if (reply.type === "error") {
      setStatus("Error: " + reply.error);
    }
  }

  const connected = snapshot?.connected ?? false;
  // The numeric value shown in the size control (fall back to the
  // snapshot's base size, then 12, until the first snapshot arrives).
  const sizeValue = fontSize ?? snapshot?.base_font_size ?? 12;
  // In pane mode the cards apply to the pane (no tab selection needed);
  // disable only while busy or disconnected. In tab mode we also need a
  // selected tab.
  const cardsDisabled = paneMode
    ? busy || !connected
    : busy || !connected || activeTab == null;

  // Which card shows as "current": the chosen pane theme (pane mode) or
  // the selected tab's theme (tab mode).
  const currentThemeId = paneMode ? paneTheme : activeTab?.current_theme ?? null;

  // Patch 0046: apply the name + light/dark/favorites filter to the grid.
  const filteredThemes = useMemo(() => {
    const q = themeSearch.trim().toLowerCase();
    return themes.filter((t) => {
      if (themeMode === "fav" && !favPresets.has(t.id)) return false;
      if (themeMode === "light" && !isLightTheme(t.background)) return false;
      if (themeMode === "dark" && isLightTheme(t.background)) return false;
      if (q && !(t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q)))
        return false;
      return true;
    });
  }, [themes, themeSearch, themeMode, favPresets]);

  // Reset the progressive window whenever the filter changes.
  useEffect(() => {
    setVisibleCount(THEME_PAGE);
  }, [themeSearch, themeMode]);

  const visibleThemes = filteredThemes.slice(0, visibleCount);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">⬢</span>
          <span className="brand-name">BethTerm</span>
          <span className="brand-sub">Settings</span>
        </div>
        <div className="toolbar">
          {paneMode && (
            <div className="size-control" title="Font size for this terminal">
              <span className="size-label">Font size</span>
              <button
                className="size-step"
                onClick={() => commitFontSize(sizeValue - 1)}
                disabled={cardsDisabled}
                aria-label="Decrease font size"
              >
                −
              </button>
              <input
                className="size-input"
                type="number"
                min={6}
                max={48}
                value={sizeValue}
                disabled={cardsDisabled}
                onChange={(e) => setFontSize(Number(e.target.value))}
                onBlur={(e) => commitFontSize(Number(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitFontSize(sizeValue);
                }}
              />
              <button
                className="size-step"
                onClick={() => commitFontSize(sizeValue + 1)}
                disabled={cardsDisabled}
                aria-label="Increase font size"
              >
                +
              </button>
              <span className="size-unit">pt</span>
            </div>
          )}
          {paneMode && (
            <div className="font-control" title="Font family for this terminal">
              <span className="size-label">Font</span>
              <select
                className="font-select"
                value={fontFamily ?? ""}
                disabled={cardsDisabled}
                onChange={(e) => commitFontFamily(e.target.value)}
              >
                <option value="">Default (window font)</option>
                {/* If the pane's current family is not in the enumerated
                    list (e.g. a config-only alias), still show it so the
                    picker reflects reality. */}
                {fontFamily && fontFamily !== "" && !fonts.includes(fontFamily) && (
                  <option value={fontFamily}>{fontFamily}</option>
                )}
                {fonts.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
          )}
          {paneMode && (
            <div className="style-control" title="Bold / italic for this terminal">
              <label
                className={"style-check" + (bold ? " on" : "")}
                title="Bold"
              >
                <input
                  type="checkbox"
                  checked={bold}
                  disabled={cardsDisabled}
                  onChange={(e) => commitFontStyle(e.target.checked, italic)}
                />
                <span style={{ fontWeight: 700 }}>B</span>
              </label>
              <label
                className={"style-check" + (italic ? " on" : "")}
                title="Italic"
              >
                <input
                  type="checkbox"
                  checked={italic}
                  disabled={cardsDisabled}
                  onChange={(e) => commitFontStyle(bold, e.target.checked)}
                />
                <span style={{ fontStyle: "italic" }}>I</span>
              </label>
            </div>
          )}
          <button
            className="download"
            onClick={download}
            disabled={downloading || busy}
            title="Update the theme catalog. Uses the network if available, otherwise the bundled Gogh snapshot."
          >
            {downloading ? "⟳ Updating…" : "⤓ Update themes"}
          </button>
          <button
            className="refresh"
            onClick={refresh}
            disabled={busy || downloading}
          >
            ↻ Refresh
          </button>
        </div>
      </header>

      <div className="body">
        {/* The tab rail is only meaningful in legacy tab mode. */}
        {!paneMode && (
          <aside className="rail">
            <div className="rail-title">Terminals</div>
            {tabs.length === 0 && (
              <div className="rail-empty">
                {connected ? "No open tabs." : "No terminal connected."}
              </div>
            )}
            {tabs.map((t) => (
              <button
                key={t.tab_id}
                className={
                  "tab-item" + (t.tab_id === selectedTab ? " active" : "")
                }
                onClick={() => setSelectedTab(t.tab_id)}
              >
                <div className="tab-title">{t.title || "(untitled)"}</div>
                <div className="tab-meta">
                  Tab #{t.tab_index}
                  {t.group_name ? ` · ${t.group_name}` : ""}
                </div>
                <div className="tab-theme">{t.current_theme}</div>
              </button>
            ))}
          </aside>
        )}

        <main
          className="content"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 500) {
              setVisibleCount((c) =>
                c < filteredThemes.length ? c + THEME_PAGE : c,
              );
            }
          }}
        >
          <div className="content-head">
            <h2>
              {paneMode
                ? `Configuring terminal #${paneId}`
                : activeTab
                  ? `Theme for: ${activeTab.title || "tab #" + activeTab.tab_index}`
                  : "Choose a theme"}
            </h2>
            {!connected && (
              <div className="notice">
                {snapshot?.notice ||
                  "Not connected to a terminal — preview only."}
              </div>
            )}
            {paneMode && connected && (
              <div className="subhead">
                Apply changes this terminal only. Use «Usar em todos» to
                save the default and recolour every open terminal.
              </div>
            )}
          </div>

          {/* Patch 0046: name search + light/dark/favorites filter. Sticky
              so it stays reachable while scrolling the (long) catalog. */}
          <div className="theme-filter">
            <input
              className="theme-search"
              type="search"
              placeholder="Search themes by name…"
              value={themeSearch}
              onChange={(e) => setThemeSearch(e.target.value)}
            />
            <div className="theme-modes">
              {(["all", "fav", "light", "dark"] as ThemeMode[]).map((m) => (
                <button
                  key={m}
                  className={"mode-chip" + (themeMode === m ? " active" : "")}
                  onClick={() => setThemeMode(m)}
                  title={
                    m === "fav"
                      ? "Show only favorites (★)"
                      : m === "light"
                        ? "Light backgrounds"
                        : m === "dark"
                          ? "Dark backgrounds"
                          : "All themes"
                  }
                >
                  {m === "all"
                    ? "All"
                    : m === "fav"
                      ? "★ Favorites"
                      : m === "light"
                        ? "☀ Light"
                        : "🌙 Dark"}
                </button>
              ))}
            </div>
          </div>

          <div className="grid">
            {visibleThemes.map((theme) => (
              <ThemeCard
                key={theme.id}
                theme={theme}
                selected={currentThemeId === theme.id}
                disabled={cardsDisabled}
                favorite={favPresets.has(theme.id)}
                onToggleFavorite={() => toggleFavorite(theme.id)}
                onUpdateFont={
                  paneMode ? () => updateFavoriteFont(theme.id) : undefined
                }
                onApply={() => applyTheme(theme.id)}
                isDefault={defaultThemeId === theme.id}
                onApplyAll={() => applyToAll(theme.id)}
                applyAllDisabled={busy}
              />
            ))}
          </div>
          {filteredThemes.length === 0 ? (
            <div className="grid-empty">
              No themes match “{themeSearch}”
              {themeMode !== "all" ? ` in ${themeMode}` : ""}.
            </div>
          ) : (
            <div className="grid-more">
              Showing {Math.min(visibleCount, filteredThemes.length)} of{" "}
              {filteredThemes.length}
              {visibleCount < filteredThemes.length ? " — scroll for more" : ""}
            </div>
          )}
        </main>
      </div>

      <footer className="statusbar">
        <span className={connected ? "dot ok" : "dot warn"} />
        {status}
      </footer>
    </div>
  );
}
