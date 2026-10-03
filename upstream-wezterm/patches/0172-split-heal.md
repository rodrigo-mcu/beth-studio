# 0172 — Un-squeeze sliver panes after a window resize

**Status:** Implemented 2026-09-25.

## Symptom

The CLIENTES window (two panes side by side), hidden in the tray and
reopened after a GUI restart, came back as **235 + 1 columns**. The
divider sat on the right window edge, where the mouse grabs the
borderless window's resize zone (patch 0020) instead of the split, so
the user could not drag it. The GUI and the host disagreed on where the
divider was (column 189 vs 236). This is the "Known issue" of patch
0163.

## Cause

The GUI and the host each keep a split tree. The GUI pushes each
pane's new size with its own `Resize` PDU; the host rebuilds its tree
from the pane sizes (`rebuild_splits_sizes_from_contained_panes`), and
the GUI then syncs back from the host tree (patch 0130). When a window
jumps from its hidden/tiny size to maximized, those messages race and a
side can settle at 1 column.

Moving the divider with `bethterm cli adjust-pane-size --pane-id <gui
id> --amount 117 Left` (through the GUI mux) fixed both trees at once,
which is what this patch automates.

## Fix

`wtinator::split_heal`:

- `find_fix` (pure, unit-tested): for each divider, look at the panes
  touching it on each side; if one side has a pane narrower than 3
  columns (or shorter than 2 rows) and both sides together have at
  least 12 cells, return the delta that moves the divider to the middle.
- `heal_tab` applies fixes with `Tab::resize_split_by` (up to 8 per
  call, re-reading the layout each time) and logs each one to
  `host-life.log` as `split heal: tab T divider D moved by N`.
- A per-window generation counter debounces: only the heal scheduled by
  the last resize runs.

`TermWindow::apply_dimensions` schedules `heal_tab` for every tab of the
window 700 ms after resizing them.

### Second round (same day): real pane sizes + periodic check

MOBI WIN came back as 1 | 235 columns and the heal did not fire: the
GUI split tree said 188 | 48 (healthy); only the real PTY sizes the
host kept were a sliver. `PaneRect` now carries `actual_cols` /
`actual_rows` from `pane.get_dimensions()`, and a pane is a sliver when
the smaller of layout and real size is under the minimum. If the layout
is already even, the fix is `resize_split_by(index, 0)`, which re-applies
the layout to the panes. The same fix is not repeated inside one call.

A window shown again from the tray may not resize at all, so the GUI
also runs one periodic check every 5 s over every tab
(`claim_periodic`, `heal_tab_throttled`: at most one heal per tab per
20 s, so a host that keeps reverting a size is not fought).

Deliberate layouts are not touched: only panes under 3 columns / 2 rows
are healed, and tabs too small to split evenly are left alone. The
healed split is 50/50, not the saved proportion.

## Files

- `wtinator/src/split_heal.rs` (new), `wtinator/src/lib.rs`
- `wezterm-gui/src/termwindow/resize.rs`
- `wezterm-gui/src/termwindow/mod.rs` — periodic check

## Revert

Remove the scheduling block in `apply_dimensions`, `split_heal.rs` and
its `mod` line. Remove row 0172 and this file.
