# Patch 0062 — Favourites are visual presets (theme + font)

**Status:** Implemented 2026-06-22. Extends patch 0060.

## Request

> "qdo salva o tema tem que salvar o tamanho da fonte e o tipo de fonte tambem."

Favouriting a theme should also remember the font, so applying that favourite
restores the whole look (colours **and** font), not just the colours.

## Change

A favourite is now a **preset**: `{ id (theme), fontSize, fontFamily, bold,
italic }`.

- **Starring (★)** a theme captures the terminal's *current* font (size /
  family / bold / italic) alongside the theme id.
- **Applying** a favourited theme applies the colours **and** the saved font in
  one go (pane mode). A non-favourited theme applies colours only, as before.
- The on-disk store (`%APPDATA%\wezterminator\theme-favorites.json`) becomes an
  array of preset **objects**. The Rust host stores it **opaquely**
  (`serde_json::Value`), so the preset shape stays owned by the frontend and can
  evolve without host changes. Legacy plain-string entries (from 0060) are
  normalised to id-only presets and a corrupt file loads as empty.

## Files

- `wtinator/src/favorites.rs` — generic JSON-array store (`Value`); tests:
  roundtrip presets, missing→`[]`, corrupt/non-array→`[]`, reject non-array on
  save, parent-dir creation.
- `wtinator-config/src/main.rs` — `get_favorites` returns `{ items }`;
  `save_favorites` takes an opaque `{ items }` array.
- `wtinator-config/frontend/src/ipc.ts` — `FavoritePreset` type;
  `FavoritesReply.items`; `saveFavorites(items)`.
- `wtinator-config/frontend/src/App.tsx` — `favPresets: Map<id, preset>`;
  capture the current font on ★; apply the saved font when applying a favourite;
  `presetsFromItems()` normaliser.

## Build / verify

```
export PATH="/c/Strawberry/perl/bin:$PATH"
cargo +nightly test -p wtinator                 # favorites::tests
cd wtinator-config/frontend && npx tsc --noEmit && npm run build
cargo +nightly build --release -p wtinator-config
```

Manual: in pane mode, set a terminal's font size / family / bold-italic, then ★
a theme → the favourite captures that font. Change things, then **Apply** that
favourited theme → the theme **and** the saved font are reapplied. Reopen the
app → the favourite (with its font) is still there
(`%APPDATA%\wezterminator\theme-favorites.json`).

## Notes

- Font capture/apply is pane-mode (per-terminal). In tab mode, applying a
  favourite sets the theme only (there is no per-pane font control there).
- The favourite captures the font when you star it. To refresh a favourite's
  font to the terminal's current settings — or to give a pre-preset
  "bookmark-only" favourite (e.g. one starred under patch 0060) a font — click
  the **↻** button on the favourited card. One click, no unstar/re-star.
