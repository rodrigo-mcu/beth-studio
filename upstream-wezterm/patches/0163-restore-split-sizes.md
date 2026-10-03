# 0163 — Restore skips sliver panes and splits by saved size

**Status:** Implemented 2026-09-23. Partial: see Known issue.

## What

Restore recreated each tab by splitting the newest pane at 50% every
time. A row of six panes became 50%, 25%, 12%… of the width. After
the 11:56 restore on 2026-09-23 four panes came back 1 column wide.
That geometry was saved, so every later restore reproduced it.

- `wtinator::session::restorable_panes` drops panes saved with fewer
  than 3 columns or 2 rows (the first pane of a tab is always kept).
  The spawn, split, and metadata passes all use the same filtered
  list, so saved entries stay aligned with live panes.
- `wtinator::session::split_percent` sizes each split from the saved
  widths (side by side) or heights (stacked) of the panes still to
  create, clamped to 10–90%.

## Known issue

With one host per window (0159), the host tab can still be tiny when
restore splits it. When the window then grows, the extra space goes
to the last pane. A two-pane tab restored in a test came back
1 + 235 columns. The cause is the host tab size at split time, not
the percentage.

## Files

- `wtinator/src/session.rs`
- `wezterm-gui/src/termwindow/session_restore.rs`

## Revert

Restore the three `filter(|p| p.tab_index == tab_index)` lists and
`SplitSize::Percent(50)`. Remove the two functions, their tests, row
0163, and this file.
