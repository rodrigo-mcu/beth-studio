# 0132 — The default includes font and style

**Status:** Implemented 2026-09-21.

## What

Patch 0110 let the Settings app save one theme as the default for every
terminal. The default now also carries the **font**: family, size
(stored as a scale against the window base size), bold and italic.

- **Usar como padrão** on a theme card saves that theme **plus the font
  currently shown in the app** (the right-clicked terminal's family,
  size, bold, italic) to `%APPDATA%\bethterm\default-theme.json`, and
  applies both to every open pane in every window. Each tab then
  reflows its PTY grids.
- New tabs and windows, and restored panes, that have **no font override
  of their own** (window font, scale 1.0, not bold, not italic) pick up
  the default font along with the default theme. A pane the user already
  styled is left alone. Splits keep inheriting the source pane.
- Old `{ "theme": "x" }` files still load; the font fields default to
  the window font. Saving only a theme keeps the saved font.

File shape:

```json
{
  "theme": "dracula",
  "font_family": "Cascadia Code",
  "font_scale": 1.25,
  "font_bold": true,
  "font_italic": false
}
```

## Files

- `wtinator/src/default_theme.rs` — `DefaultStyle`, `load_style`,
  `save_style`, `apply_font_to_pane`, `pane_font_is_untouched`;
  `apply_to_pane_if_unset` stamps the font too.
- `wtinator/src/notify_ipc.rs` — `set_default_theme` accepts
  `font_family`, `font_size` (points), `font_bold`, `font_italic`;
  `apply_font_to_all_panes`.
- `wtinator-config/src/main.rs` — forwards the font fields; saves them
  locally when launched standalone.
- `wtinator-config/frontend/src/{ipc.ts,App.tsx,ThemeCard.tsx}` and the
  rebuilt `frontend/dist/index.html`.

## Verification

- `cargo +nightly test -p wtinator --lib` — 192 passed (new:
  `style_roundtrips_and_theme_save_keeps_font`).
- Manual: set family + bold on a terminal, click **Usar como padrão**,
  open a new tab: it has the theme and the font.

## Revert

Restore the theme-only `Store`, drop the font fields from the request
and the app, and remove row 0132 from `PATCHES.md` plus this document.
