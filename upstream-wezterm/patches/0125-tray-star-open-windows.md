# 0125 — Tray always shows window list; mark open with *

**Status:** Implemented 2026-09-17.

## What

Left-click on the tray icon always opens the window picker (it used
to auto-restore when exactly one window was hidden). Every live
window stays in the list. Rows for windows that are already visible
get a leading `* ` so open vs tray-hidden is obvious at a glance.

## Files

- `wtinator/src/tray.rs`

## Revert

Restore the `hidden.len() == 1 → restore_all` left-click branch and
drop the `* ` prefix from `menu_window_labels`.
