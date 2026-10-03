# Patch 0076 — let the bottom pane render every PTY row

## Problem

At the bottom of a window, a typed line appeared until Enter. Enter scrolls
the terminal and moves the cursor to the final logical viewport row; the
renderer then hid that row because it derived a smaller row count from the
window's pixel height after custom bars and headers had already consumed part
of it.

## Implementation

For a pane that reaches the window bottom, use `dims.viewport_rows` directly:
the pane's PTY owns the authoritative number of content rows. Internal split
panes retain the conservative physical-height limit so they cannot paint
through a divider.

## Validation

Validated with `cargo +nightly check -p wezterm-gui`, the Windows release
build for `wezterm` and `wezterm-gui`, and `cargo +nightly test -p wtinator`
(148 tests passed).

## Revert

Restore the bottom-pane pixel-height row calculation, then remove this
document and row 0076 from `PATCHES.md`.
