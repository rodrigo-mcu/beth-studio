# Patch 0060 — Persist theme favourites on disk (fix favourites not saving)

**Status:** Implemented 2026-06-22.

## Symptom

> "a funcao de salvar temas em favoritos nao funciona"

Marking a theme as a favourite (the ★ on a `ThemeCard`) did not survive
reopening the WezTerminator Settings window.

## Cause

`wtinator-config` is a `wry` WebView2 window whose UI is loaded with
`WebViewBuilder::new().with_html(html)`. Loading via `with_html` (WebView2's
`NavigateToString`) gives the document a **`null` origin**, and WebView2 does
**not** persist `localStorage` for a null origin. Favourites were stored only in
`localStorage` (`wt_favorite_themes`), so they were wiped on every
config-window spawn. (Patch 0046 explicitly flagged this risk.)

A persistent `WebContext` data dir alone would not fix it — a null origin has
no persistent storage partition. So the favourites are moved off the WebView
and onto disk on the Rust side.

## Fix — disk JSON via the existing IPC bridge

- **`wtinator/src/favorites.rs`** (new): `load()` / `save()` a JSON array of
  theme ids at `%APPDATA%\wezterminator\theme-favorites.json` (Windows) /
  `~/.config/wezterminator/theme-favorites.json` (other) — the same directory
  as `session.json` and the downloaded `themes/`. A missing file loads as an
  empty list. Unit-tested (roundtrip, missing-file, parent-dir creation).
- **`wtinator/src/lib.rs`**: `pub mod favorites;`.
- **`wtinator-config/src/main.rs`**: two IPC request handlers —
  `get_favorites` → `{ "type":"favorites", "ids":[…] }`, and
  `save_favorites { ids }` → `{ "type":"save_favorites_result", "ok":true }`.
- **`wtinator-config/frontend/src/ipc.ts`**: `FavoritesReply` /
  `SaveFavoritesResult` types + `getFavorites()` / `saveFavoritesIds()` (with a
  localStorage fallback in browser/demo mode so the UI is still developable
  without a host).
- **`wtinator-config/frontend/src/App.tsx`**: load favourites from the host on
  mount (a `useEffect`) and save them via IPC on each toggle, replacing the
  removed `localStorage` helpers.

## Files

- `wtinator/src/favorites.rs` (new)
- `wtinator/src/lib.rs`
- `wtinator-config/src/main.rs`
- `wtinator-config/frontend/src/ipc.ts`
- `wtinator-config/frontend/src/App.tsx`

## Build / verify

```
export PATH="/c/Strawberry/perl/bin:$PATH"
cargo +nightly test -p wtinator                 # favorites::tests
cd wtinator-config/frontend && npm install && npm run build   # re-embed dist/
cargo +nightly build --release -p wtinator-config
```

The frontend MUST be rebuilt (`npm run build`) because `rust-embed` bakes
`frontend/dist` into the binary at compile time.

Manual: open Settings → ★ a theme → close → reopen → the ★ is still set, and
`%APPDATA%\wezterminator\theme-favorites.json` contains the ids.

## Notes

- The favourites file is shared regardless of which terminal launched the
  config app (it is global per user, like the downloaded themes).
