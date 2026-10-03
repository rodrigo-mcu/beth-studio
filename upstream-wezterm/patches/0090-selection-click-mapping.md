# 0090 — Mouse selection lands on the clicked cell

## Problem

Selecting text with the mouse sometimes highlighted a range away from the
click. Two coordinate bugs stacked:

1. **List mode.** Paint and resize reserve `pane_strip_pixel_height()` under
   the tab bar. Mouse hit-testing did not subtract that strip, so every click
   was several rows too low in the mux grid whenever list mode was on.
2. **Per-pane font scale.** After finding the pane, the code converted
   window cells then did `cell / scale`. That is not the same as
   `pixel / scaled_cell_size`, so the highlight drifted inside a zoomed pane.

## Fix

- Include the pane strip in the window-level Y origin (same formula as
  `paint_pane` / `resize.rs`).
- Map the click to the pane's content cell in pixel space: grid origin,
  pane `left`/`top` in base cells, one base-cell header, then divide by
  that pane's render metrics.

## Revert

Restore the previous `first_line_offset` (tab bar + border only) and the
`scale_local_cell` integer path.
