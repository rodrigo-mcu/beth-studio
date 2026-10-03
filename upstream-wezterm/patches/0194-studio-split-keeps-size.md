# 0194 — Studio column size sticks

**Status:** Implemented 2026-09-27.

## What

"Novo terminal à direita" (and the other sides) in Beth Studio creates a
new host tab in the same mux window. Only the Studio layout is split.
**Ajustar à janela** then sizes that pane to the column.

The native window treated the difference as a stale grid and called
`tab.resize(window size)` from `ensure_pane_geometry` on the next paint,
and `apply_dimensions` resized every tab in the window. The PTY went
back to the full window width while Studio still drew a half column, so
full-screen text broke.

`ensure_pane_geometry` now pushes the window size only when this
window's grid changed, or when the tab already matches the window and a
per-pane font is stale. An external resize leaves the pane alone.
`apply_dimensions` resizes only the tab that window is showing. Choosing
another tab in the native window fills that tab to the window.

## Files

- `wezterm-gui/src/termwindow/mod.rs`
- `wezterm-gui/src/termwindow/resize.rs`

## Revert

Restore the "resize every tab" loop in `apply_dimensions`, the
unconditional `tab.resize(self.terminal_size)` in `ensure_pane_geometry`,
and remove the resize from `activate_tab`. Remove the
`geometry_window_cols` / `geometry_window_rows` fields. Remove row 0194
and this file.
