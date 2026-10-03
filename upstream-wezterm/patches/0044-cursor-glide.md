# Patch 0044 — Cursor GLIDE (macOS / modern-editor style)

**Status:** Implemented (first cut — builds clean; visual tuning pending). 2026-06-13.

The text cursor of the **active pane** smoothly **slides** from its old pixel
position to its new one when it moves (typing, arrow keys) instead of teleporting.
When the cursor is **idle** (settled at its cell), the normal per-cell cursor
renders and blinks/fades (patch 0042). So you get both: glide while moving, fade
while idle.

## Model — "glide while moving, normal cell cursor while idle"
1. Track the active pane's **rendered cursor pixel rect** (window coords) across
   frames in `TermWindow.cursor_glide: RefCell<Option<CursorGlideState>>`.
2. Each frame, in `paint_pane` for the active pane, compute the **target** rect
   from `StableCursorPosition` using the SAME geometry the per-line cell render
   uses, then ease the rendered rect toward it (time-based, frame-rate
   independent).
3. **Settled** (within `GLIDE_SETTLE_PX`): clear nothing, draw no overlay, let
   the normal cell cursor render (it blinks via patch 0042).
4. **Gliding**: suppress the per-cell cursor for this pane this frame, draw an
   **overlay block** (layer 2) at the rendered rect in `cursor_bg`, and request
   another frame (~16ms) so the slide continues.

## Files changed
- `wezterm-gui/src/termwindow/prevcursor.rs`
  - Added `CursorGlideState` struct (the state) + the tuning constants
    `GLIDE_DURATION_MS`, `GLIDE_MAX_CELLS`, `GLIDE_SETTLE_PX`.
- `wezterm-gui/src/termwindow/mod.rs`
  - New fields `cursor_glide: RefCell<Option<CursorGlideState>>` and the per-paint
    `cursor_glide_active: Cell<bool>` (+ `Cell` import, `CursorGlideState` import,
    constructor init).
- `wezterm-gui/src/termwindow/render/mod.rs`
  - `compute_cell_fg_bg`: when `cursor_glide_active && is_active_pane`, force the
    cursor `visibility = Hidden` so it returns `cursor_shape: None` (no quad, no
    fg/bg swap) — this is how the cell cursor is suppressed during a glide.
  - `LineQuadCacheKey`: added `cursor_glide_suppressed: bool` so a cached cursor
    row rendered with the cursor suppressed is never reused once the glide settles
    (and vice-versa).
- `wezterm-gui/src/termwindow/render/pane.rs`
  - `paint_pane`: call `update_cursor_glide(...)` BEFORE the per-line render (it
    sets `cursor_glide_active`, which the line render reads), then draw the
    returned overlay block AFTER the lines (layer 2, before the focus outline).
  - New method `update_cursor_glide(...)` — all the glide logic.
  - `quad_key` now sets `cursor_glide_suppressed`.

## State struct (`prevcursor.rs`)
```
pub struct CursorGlideState {
    pub rendered_x: f32, pub rendered_y: f32,  // current rendered top-left (window px)
    pub width: f32, pub height: f32,           // cell size (pane-scaled)
    pub pane_id: PaneId,                        // detect active-pane change -> teleport
    pub viewport_top: StableRowIndex,           // detect scroll -> teleport
    pub last_update: Instant,                   // for time-based ease
}
```

## Target pixel rect (matches the per-line cell render exactly)
With BASE (window) cell metrics for the pane rectangle origin and SCALED
(pane, patch 0039) metrics for the cell size + within-pane advance:
- `left_pixel_x = padding_left + border.left + pos.left * base_cell_width`
- `target_x = left_pixel_x + cursor.x * pane_cell_width`
- `target_y = (top_pixel_y + header_offset) + pos.top * base_cell_height
              + (cursor.y - viewport_top) * pane_cell_height`
- `w = pane_cell_width`, `h = pane_cell_height`
- `viewport_top = current_viewport.unwrap_or(dims.physical_top)`
- Clamped to the pane's visible rect.

This mirrors `LineQuadCacheKey.top_pixel_y`
(`content_top + pos.top*base_cell_h + line_idx*pane_cell_h`, `line_idx =
cursor.y - viewport_top`) and `left_pixel_x + cursor.x*pane_cell_w` from
`screen_line.rs` (without screen_line's `-pixel_width/2` centering term, because
`filled_rectangle` already converts window coords to clip space — same as the
focus border / dock overlay).

## Cell-cursor suppression (the exact plumbing)
- `paint_pane` sets `self.cursor_glide_active` (a `Cell<bool>`) at the top, before
  the line render: `true` for the active pane while gliding, `false` otherwise
  (and `false` for every non-active pane).
- `compute_cell_fg_bg` reads `self.cursor_glide_active.get()` directly (it's a
  `&self` method) and, when set on the active pane, overrides `visibility` to
  `Hidden`. No new field was threaded through `RenderScreenLineParams` /
  `ComputeCellFgBgParams` — the `Cell` on `TermWindow` is the least-invasive hook.
- Cache correctness: `LineQuadCacheKey.cursor_glide_suppressed` keeps suppressed
  vs non-suppressed renders of the cursor row in separate cache slots.

## Easing
Frame-rate-independent exponential ease-out: each frame closes
`alpha = 1 - exp(-dt / tau)` of the remaining gap, `tau = (GLIDE_DURATION_MS/1000)/3`
(~3 time constants ≈ the full glide). Naturally fast-then-slow.

## Tuning constants (top of `prevcursor.rs`)
- `GLIDE_DURATION_MS = 110.0` — slide length.
- `GLIDE_MAX_CELLS = 40.0` — jumps larger than this (Euclidean, in cells) teleport
  instead of gliding (so `cls` / big paste don't fly across the screen). Raise to
  effectively disable.
- `GLIDE_SETTLE_PX = 1.0` — within this distance of target → settle (no overlay).

## Teleport (no glide) conditions
Window unfocused, cursor hidden, active pane changed, viewport scrolled, no prior
state (first paint), or jump > `GLIDE_MAX_CELLS`. State is reseeded to the target
so the NEXT real move glides from the right spot.

## Scope / non-goals / TODOs
- Only the ACTIVE pane glides; other panes render normally.
- Overlay is always a **block** (most cursors here are BlinkingBlock per 0042). A
  bar/underline cursor still glides as a block during the slide, then the real
  bar/underline cell cursor renders when settled. TODO: shape-correct overlay for
  bar/underline if desired.
- TODO: the solid block briefly covers the glyph under it during the ~100ms slide
  (no glyph re-draw on top). Acceptable for v1.
- Scroll-during-glide and mouse-driven cursor: teleport (viewport change resets).

## Build
```
export PATH="/c/Strawberry/perl/bin:$PATH"
cargo +nightly build --release -p wezterm-gui -p wtinator-config \
  --manifest-path <workspace>/upstream-wezterm/Cargo.toml
```
Builds clean (EXIT=0); binary written.

## Correctness risks to watch when testing (cannot verify GUI here)
- **Pixel mapping**: target geometry is derived to match the line render, but the
  pane-scale (0039) base-vs-scaled split is subtle — verify the block lands
  exactly on the cell at scale ≠ 1.0.
- **Double cursor**: suppression relies on the `cursor_glide_active` flag being
  set before the active pane's lines render and the cache key including
  `cursor_glide_suppressed`. Watch the settle frame (overlay off ↔ cell cursor on)
  for a 1-frame flicker or doubling.
- **Glide on unrelated jumps**: `GLIDE_MAX_CELLS` guards big jumps; small program-
  driven moves (e.g. a TUI repainting the cursor) will still glide — may look odd.
