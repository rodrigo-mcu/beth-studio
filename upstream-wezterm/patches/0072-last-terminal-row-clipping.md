# Patch 0072 — keep the final terminal row visible after resize

## Problem

The pane renderer used `floor()` when converting the physical content height
to the number of rows to draw. A fractional cell left by a window/split resize
caused the final PTY row to be skipped completely, so the latest prompt or
output could disappear until a full redraw such as `clear`.

## Implementation

- Count a partially visible final row with `ceil()` when the pane reaches the
  window's bottom edge, where normal client clipping is safe.
- Keep the conservative `floor()` behavior for panes above an internal split,
  preventing a partial row from bleeding into the pane below.
- Keep the count capped at the pane's actual PTY viewport rows, so stale rows
  are still not rendered after a split resize.

## Validation

Validated with `cargo +nightly check -p wezterm-gui`, the Windows release build
for `wezterm` and `wezterm-gui`, and `cargo +nightly test -p wtinator` (148
tests passed).

## Revert

Restore `floor()` in `render/pane.rs`, then remove this document and row 0072
from `PATCHES.md`.
