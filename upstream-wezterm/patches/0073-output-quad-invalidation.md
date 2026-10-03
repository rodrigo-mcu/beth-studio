# Patch 0073 — invalidate line quads on visible PTY output

## Problem

After terminal output scrolls the viewport, rows can have the same visual
shape (especially blank rows) while their physical placement/content changes.
The line-quad cache could then reuse a quad from the previous viewport. A
full-screen command such as `clear` appeared to fix the issue because it
changed enough line state to force a redraw.

## Implementation

Advance `quad_generation` for every visible `PaneOutput` notification. This
invalidates cached geometry quads for the next frame without discarding the
font and line-shape caches.

## Validation

Validated with `cargo +nightly check -p wezterm-gui`, the Windows release
build for `wezterm` and `wezterm-gui`, and `cargo +nightly test -p wtinator`
(148 tests passed).

## Revert

Remove the `quad_generation` increment from `mux_pane_output_event`, then
remove this document and row 0073 from `PATCHES.md`.
