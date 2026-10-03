# Patch 0074 — invalidate cached line shape state on PTY output

## Problem

The renderer stores a weak `CachedLineState` reference in each `Line`. During
in-place terminal updates, that appdata can remain associated with a stale
shape hash. The line quad cache is rebuilt, but the stale shape hash can cause
the line-shape cache to reuse the prompt-only content. Visually, the directory
prompt remains while text typed after it disappears until `clear` forces a
larger redraw.

## Implementation

Clear `line_state_cache` whenever a visible pane emits `PaneOutput`, alongside
the existing quad-generation advance. The next render recomputes each visible
line's shape hash from its current cells; unrelated font rasterization caches
remain intact.

## Validation

Validated with `cargo +nightly check -p wezterm-gui`, the Windows release
build for `wezterm` and `wezterm-gui`, and `cargo +nightly test -p wtinator`
(148 tests passed).

## Revert

Remove the `line_state_cache` clear from `mux_pane_output_event`, restore the
0073 comment if desired, then remove this document and row 0074 from
`PATCHES.md`.
