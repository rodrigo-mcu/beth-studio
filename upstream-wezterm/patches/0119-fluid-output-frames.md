# 0119 — Fluid output: keep caches, coalesce Tab floods

**Status:** Implemented 2026-09-16.

## Symptom

With one WSL pane, pressing Tab for completion froze the whole
window. The same shell inside Terminator on WSL2 stayed smooth.
CPU/RAM were not the bottleneck.

## Cause

Patches 0073–0075 wiped every line-shape/quad cache and bumped
`quad_generation` on **every** `PaneOutput`. Tab completion is an
in-place flood (dozens of PTY chunks per key). Each chunk then
reshaped the entire screen and posted another GUI hop.

## Strategy (spend RAM, keep the UI moving)

1. Wipe caches only when `physical_top` moves (Enter scroll).
   In-place updates miss via `shape_hash` / pixel Y.
2. Coalesce `PaneOutput` hops: one main-thread task per burst.
3. Default `mux_output_parser_coalesce_delay_ms = 12` and 4× line
   caches (4096) so a completion frame is one paint.

PTY/mux keep running. We do not pause ConPTY.

## Files

- `wezterm-gui/src/termwindow/mod.rs`
- `wtinator/src/cursor_anim.rs`

## Revert

Restore the unconditional cache wipe in `mux_pane_output_event` and
the per-notification subscribe hop.
