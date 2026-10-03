# Patch 0046 — Theme browser: search, light/dark/favorites filter, lazy render

**Status:** Implemented 2026-06-14. Frontend-only (the React config app);
depends on 0038 (theme downloader) and 0040 (per-terminal config window).

With the Gogh catalog the theme grid rendered hundreds of cards at once (slow
to open). This makes the grid browsable and cheap.

## Changes — `wtinator-config/frontend/`

- **Name search** — a search box filters themes by `name`/`id` (substring,
  case-insensitive).
- **Light / Dark / Favorites / All filter** — chips. Light vs dark is derived
  from each theme's `background` luminance (Rec. 601, threshold 0.5).
- **Favorites** — a ★ toggle on each `ThemeCard`; the set of favorite theme ids
  is persisted in `localStorage` (`wt_favorite_themes`). NOTE: the WebView is
  created with `WebViewBuilder::new().with_html(...)` and no explicit data
  directory, so localStorage may be session-only across config-window spawns;
  if favorites don't persist, set a stable `WebContext` data dir in
  `wtinator-config/src/main.rs`.
- **Progressive render** — the grid renders `THEME_PAGE` (36) cards and grows by
  another page when the user scrolls within ~500px of the bottom
  (`onScroll` on `.content`). `visibleCount` resets when the filter changes. A
  footer shows "Showing N of M".

`App.tsx`: `themeSearch` / `themeMode` / `visibleCount` / `favorites` state,
`isLightTheme()` helper, `filteredThemes` memo, the sticky `.theme-filter` bar.
`ThemeCard.tsx`: `favorite` + `onToggleFavorite` props + the ★ button.
`styles.css`: `.theme-filter`, `.theme-search`, `.mode-chip`, `.card-fav`,
`.grid-more`/`.grid-empty`.

## Build
```
cd upstream-wezterm/wtinator-config/frontend && npm run build   # → dist/index.html
cargo +nightly build --release -p wtinator-config               # embeds dist
```
(`wezterm-gui` does not change.)
