# Patch 0075 — invalidate pre-shaped lines after terminal scroll

## Problem

The final editable terminal row rendered normally, but pressing Enter caused
it to disappear as the terminal scrolled it into the preceding row. The line
state cache was cleared on `PaneOutput`, but a stale prepared line shape or
quad could still be reused for the shifted row.

## Implementation

On visible PTY output, clear the line-state cache, prepared line-shape cache
and line-quad cache before invalidating the window. Glyph/font atlas caches
remain intact; only terminal-line content is rebuilt.

## Validation

Validated with `cargo +nightly check -p wezterm-gui`, the Windows release
build for `wezterm` and `wezterm-gui`, and `cargo +nightly test -p wtinator`
(148 tests passed).

## Revert

Remove the prepared-line and line-quad cache clears from
`mux_pane_output_event`, then remove this document and row 0075 from
`PATCHES.md`.
