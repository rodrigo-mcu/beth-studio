# 0137 — Pane geometry check only when something changed

**Status:** Implemented 2026-09-21.

## What

`TermWindow::ensure_pane_geometry` (patch 0043) walked every pane of the
active tab on **every paint**, recomputing per-pane font metrics and
comparing grids, and called `tab.resize` on any mismatch. It is now
gated by `pane_geometry_dirty`, set by the events that can change a
pane grid:

- window resize (`apply_dimensions`),
- `TabResized`, `TabAddedToWindow`, `PaneAdded`, `PaneRemoved`,
  `WindowInvalidated` mux notifications,
- a per-pane font change (`apply_pane_font_scale_change`),
- dashboard open/close (goes through `apply_dimensions`).

The flag starts set so the first paint still self-heals. When the walk
finds a stale pane it calls `tab.resize`, which emits `TabResized` and
re-arms the flag, so a real mismatch is re-checked on the next paint
until it converges.

## Files

- `wezterm-gui/src/termwindow/mod.rs`
- `wezterm-gui/src/termwindow/resize.rs`

## Revert

Remove the field and the early return; remove row 0137 and this file.
