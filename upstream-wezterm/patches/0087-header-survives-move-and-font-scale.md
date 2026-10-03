# Patch 0087 — Pane name bar survives move and font scale

**Applied:** 2026-09-05

## What

Moving a tab to a new window (especially one that then maximizes) or changing
a pane's font size could leave the mux PTY at the previous cell count. The
visible result was: the top name bar disappeared, and the terminal content no
longer filled the pane.

- `cascade_size_from_cursor` now reserves the header row like the other
  resize paths, so a reflow cannot cover the name bar with an extra PTY row.
- `ensure_pane_geometry` also compares PTY **rows** (after the header
  reservation) and resizes the tab to the live `terminal_size` when the
  window has grown (maximize / move).
- A font-size change re-syncs the tab to the current window pixel size.
- The name bar stays visible in WezTerminator mode except on the alternate
  screen.

## Files

- `mux/src/tab.rs`
- `wezterm-gui/src/termwindow/mod.rs`
- `wezterm-gui/src/termwindow/render/pane.rs`
- `PATCHES.md`

## Verification

```powershell
cargo +nightly check -p wezterm-gui
```

Manual: move a tab to a new window, then increase/decrease that pane's font.
The `Tab #N` name bar must remain at the top and the prompt/content must fill
the rest of the pane.

## Revert

Undo the listed changes, delete this file, and remove the 0087 entry from
`PATCHES.md`.
