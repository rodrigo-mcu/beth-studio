# 0102 — Header rename text readable (reverse video)

## What

Double-click rename painted a navy bar, then `render_screen_line`
honoured the pane’s `reverse_video` and swapped fg/bg. The glyphs
became the same colour as the bar (`glyph_color == bg_color` then
skips drawing). An empty custom title also left a blank navy strip
with no caret, which looked like invisible text.

Edit mode now always uses black ink on a white field (Windows text
box), `reverse_video = false`, bold glyphs, and a blinking caret
(`stable_line_idx = Some(0)` plus the pane so `compute_cell_fg_bg`
does not panic).

## Files

- `wtinator/src/header/mod.rs`
- `wezterm-gui/src/termwindow/render/pane.rs`

## Revert

Restore luminance-based `HEADER_EDIT_*` colours,
`stable_line_idx: None`, `pane: None`, and
`RenderableDimensions { ..dims.clone() }`.
