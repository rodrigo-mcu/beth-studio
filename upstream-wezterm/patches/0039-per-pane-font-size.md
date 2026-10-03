# Patch 0039 — Per-pane (per-terminal) font size

**Applied:** 2026-06-13
**Status:** Active (core confirmed working; two follow-ups listed below).

## What

Each **terminal (pane) can have its own font size**, independent of the
others in the same window — mirroring the per-pane *theme* model. Grow
/ shrink / reset the font of the pane you **right-click** via the new
context-menu **"Font size"** submenu (Increase / Decrease / Reset), or
with the keys **Ctrl+Shift+= / Ctrl+Shift+- / Ctrl+Shift+0** (also in
the command palette as "Increase/Decrease/Reset pane font size"). The
right-clicked pane is the target (not the active pane).

Confirmed by the user 2026-06-13: in a split tab, scaling one pane
changes only that pane.

## The core problem & the model

Font size in wezterm is **window-global**: one `FontConfiguration`
(`TermWindow.fonts`) and one `RenderMetrics` (`TermWindow.render_metrics`,
the cell pixel size) per window, and the split layout + PTY sizing both
assume a **single uniform cell size per grid**. Per-*pane* size is much
harder than per-pane *colour* (a palette never touches the cell grid).

The model that makes it tractable:

- **The split tree stays in the window's uniform BASE cell size.** So
  each pane's pixel rectangle (`PositionedPane{left,top,width,height,
  pixel_width,pixel_height}`, built only from tree node sizes in
  `mux/src/tab.rs`) is unchanged by scaling. Dividers don't move.
- **Only two things diverge for a scaled pane:** its PTY grid
  (`cols/scale × rows/scale` in the *same* pixel rect, so its derived
  cell size = `base_cell × scale`) and the glyph size at render.
- Therefore a pane's **position** uses base metrics while its
  **content** uses the pane's scaled metrics. The renderer must keep
  these separate (the subtle part — see below).

## Key pieces

**Phase 1 — per-pane state (`mux`):**
- `mux/src/pane.rs`: `Pane::get_font_scale(&self) -> f64 { 1.0 }` /
  `set_font_scale(&self, _)` (default no-op, mirrors `palette`/
  `set_palette`; remote/client panes stay at 1.0).
- `mux/src/localpane.rs`: `LocalPane` stores `font_scale: Mutex<f64>`
  (init 1.0); the setter clamps to `0.25..=6.0`.

**Phase 2 — layout (`mux/src/tab.rs`):**
- `scale_size(size, scale)` returns `cols/scale × rows/scale` at the
  same `pixel_width/pixel_height` (so the terminal's cell size scales,
  the rect doesn't). Scale 1.0 is returned unchanged.
- Applied at every leaf `pane.resize(...)`: `apply_sizes_from_splits`
  (the main path, run on every tab resize), the zoom path, and the
  per-leaf apply path. The tree node sizes (hence `PositionedPane`)
  stay in base cells; only the PTY grid handed to each pane scales.

**Phase 3 — render (`wezterm-gui`):**
- `render/mod.rs::fonts_and_metrics_for_pane_scale(scale)` builds (once,
  cached by `NotNan(scale)` in a new `TermWindow.pane_font_cache`) a
  `FontConfiguration` at `window_scale × pane_scale` + its
  `RenderMetrics`. Scale 1.0 returns the window's; any font-load error
  falls back to the window's (never panics).
- `render/pane.rs::paint_pane`: reads `pos.pane.get_font_scale()`,
  captures the **base** cell metrics + pane-origin `left_pixel_x`
  *before* swapping, then scoped-swaps `self.fonts` + `self.render_metrics`
  to the pane's scaled values around `with_lines_mut` (the shaper reads
  `self.fonts`/`self.render_metrics` with no per-pane param), restoring
  on **both** the ok and error paths. The per-line Y splits base vs
  scaled: `content_top + pos.top·BASE_cell_h + line_idx·SCALED_cell_h`;
  columns lay out at the scaled cell width. Pane background rect / split
  dividers keep using base metrics (correct — the rect is unchanged).
- `render/mod.rs`: `LineToEleShapeCacheKey` gains `pane_font_scale:
  NotNan<f64>` so two panes at different scales rendering identical text
  in the same frame don't collide in the shape cache. (`LineQuadCacheKey`
  already keys on `pane_id`, so no change there.)
- The glyph atlas already keys on `metric` (from `RenderMetrics`) +
  `font.id()`, so different scales never collide at the glyph level.

**Phase 4 (this cut) — UI:**
- `config/src/keyassignment.rs`: `IncreasePaneFontSize` /
  `DecreasePaneFontSize` / `ResetPaneFontSize` key assignments.
- `wezterm-gui/src/commands.rs`: three `CommandDef`s (command palette +
  default keys Ctrl+Shift+= / - / 0, View ▸ Font Size menubar).
- `wezterm-gui/src/termwindow/mod.rs`: the handlers set the active
  pane's scale (×1.1 / ÷1.1 / 1.0) then `apply_pane_font_scale_change`
  — bumps `shape_generation`/`quad_generation`, clears the shape/quad
  caches, and `tab.resize(tab.get_size())` so the mux reflows the
  scaled pane's PTY, then repaints.
- `wtinator/src/context_menu.rs`: a "Font size" submenu (Increase /
  Decrease / Reset, wIDs `0x6400..=0x6402`) that maps to the three
  `KeyAssignment`s. The menu dispatch already targets the right-clicked
  pane via `PerformAssignment { pane_id, .. }`, so it scales the pane
  under the cursor.
- `wtinator/src/menu_icons.rs`: a `MenuIconId::FontSize` icon (a blocky
  capital "A").

## Known follow-ups

- **Mouse hit-test inside a scaled pane** still maps pixel→cell with the
  window metrics, so clicks/selection in a scaled pane target the wrong
  cell. Keyboard + reading work fully. A `TODO(patch 0039)` marks the
  spot in `mouseevent.rs`. (Next.)
- **Persistence**: the per-pane scale is not yet saved in
  `wtinator::session`, so it resets to 1.0 on restart. (Next.)
- Splits with different sizes have intentionally uneven line heights
  between panes (the accepted trade-off of true per-pane sizing).

## Verification

- Builds clean: `cargo +nightly build --release -p wezterm-gui
  -p wtinator-config` (run with `C:\Strawberry\perl\bin` on PATH so
  `openssl-sys` can build — see the note in
  `phase-0-build-environment`).
- Manual (2026-06-13): split a tab, right-click a pane → Font size →
  Increase → **only that pane** scales; the sibling is unchanged.
