# Patch 0043 — Per-terminal FONT FAMILY (+ per-pane size, hardened)

**Status:** Implemented 2026-06-14. Builds on patches 0039/0040 (per-pane
size/scale), 0041 (per-pane persistence) and 0044 (cursor glide).

Each pane can pick its own **font family** (typeface) AND **size**, chosen from
the "Configure this terminal…" window. The per-pane *size* already shipped in
0039/0040; this patch adds *family* and, in the process, fixes a regression that
had broken per-pane size and hardens the whole per-pane-font path.

> This file documents the design that actually shipped. An earlier plan (and a
> first implementation, preserved only in git history) used
> `config::overridden_config({font, font_size})` + a 3-writer `cell_scale`
> field; both were wrong (see **Pitfalls** below) and were replaced.

## The core problem

Per-pane SIZE is a single uniform scalar `s` — `scale_size` divides cols & rows
by `s`. A FAMILY change is NOT uniform: different typefaces have different cell
aspect ratios, so the pane's cell **width and height each change by a different
factor**. The mux lays panes out in the window's BASE cell (uniform pixel
rects); only each leaf's PTY grid rescales. The mux has no font metrics, so the
GUI must supply the per-axis factor.

## Final architecture

### mux stores intent; the GUI owns geometry
`mux` must not depend on `wezterm-font`. The pane stores two **independent
sources of truth** plus one GUI-derived value:

- `font_scale: f64` — the size scale (patch 0039). Set by config/keyboard/
  restore. **Sole source for size.** `Pane::get/set_font_scale`.
- `font_family: Option<String>` — the typeface (None = window font). Set by
  config/restore. `Pane::get/set_font_family`.
- `family_ratio: (f64, f64)` — the family's cell aspect **relative to the
  size-scaled window cell**. `(1.0, 1.0)` whenever the pane is on the window
  font, *regardless of size scale*. Written by the GUI **only**.
  `Pane::get/set_family_ratio` (`mux/src/localpane.rs`; clamped 0.1..10.0).

`set_font_scale` is byte-identical to patch 0039 (it does NOT touch
`family_ratio`). This is what guarantees the size path can never regress.

### Reflow — `mux/src/tab.rs`
`scale_size(size, width_factor, height_factor)` is two-factor. The three call
sites pass `scale * ratio` per axis:
```rust
let scale = pane.get_font_scale();
let (rw, rh) = pane.get_family_ratio();
scale_size(size, scale * rw, scale * rh)
```
For a window-font pane `(rw, rh) == (1, 1)`, so this is exactly the proven
patch-0039 `scale_size(size, scale)`.

### Render — `wezterm-gui/src/termwindow/render/mod.rs`
`fonts_and_metrics_for_pane_font(pane_scale, family)` builds an isolated
`(FontConfiguration, RenderMetrics)`:
- **Family swap, not config re-read.** `ConfigHandle::with_font_family(fam)`
  (`config/src/lib.rs`) clones the FULL window config (keeping every setting and
  the WezTerminator runtime overrides) and replaces only the primary `font`
  family, keeping the existing list as fallbacks. The size is then applied with
  `cfg.change_scaling(window_scale * pane_scale)` — the **proven** 0039 path,
  used for both the window font and a swapped family.
- Cache key `PaneFontKey { family, font_size }` where `font_size` holds the
  **effective** scale (`window_scale * pane_scale`) so a global zoom invalidates
  it too.
- **Degenerate-cell guard:** if the built cell is `< 2px` in either axis (an
  icon/symbol/non-monospace face, e.g. `teamviewer13`, `HoloLens MDL2 Assets`),
  bail → fall back to the window font instead of a 0px cell that explodes the
  column count.

`paint_pane` (`render/pane.rs`) scoped-swaps `self.fonts`/`self.render_metrics`
to the pane's values for the line render (gate: `!Rc::ptr_eq`), and clamps the
line `pixel_width` to the pane's pixel RECTANGLE
(`min(dims.cols*pane_cell, pos.width*base_cell)`) so content wider than the pane
(e.g. lines printed at a smaller font before a size increase, not yet re-wrapped)
is clipped at the divider instead of bleeding into the neighbour.

### Two writers of `family_ratio`, both idempotent
- `apply_pane_font_scale_change` (`termwindow/mod.rs`): on an explicit font
  change (keyboard / config-window apply), recompute each active-tab pane's
  ratio, clear the line/quad caches, and reflow. Immediate, no lag.
- `ensure_pane_geometry` (`termwindow/mod.rs`, called at the top of every
  `paint_pass`): the **self-heal**. Recompute each pane's ratio and, if its PTY
  column count no longer matches what its font wants in its rectangle, reflow.
  This covers the paths that reflow the mux WITHOUT calling apply — session
  restore, split creation, window resize — which otherwise leave a pane's grid
  stale (content overflows). The target column count uses the EXACT same
  identity-shortcut + floor as `scale_size`, so a correct pane matches and it
  converges in one frame (no oscillation, no per-frame reflow in steady state).

### Cursor glide (patch 0044) interaction
The glide interpolates cursor pixel positions tuned for the uniform window cell.
For a pane with a font override the math is unstable (the cursor can shoot to
mid-screen), so `update_cursor_glide` returns early for any pane with a non-1.0
scale or a family set — the normal cell cursor renders there with the pane's
correct scaled metrics. Window-font panes still glide.

### IPC + UI
- `notify_ipc.rs`: `SetPaneFontFamily { pane_id, family }` (None clears),
  `ListFonts` (returns the family names the host can load). Fonts are enumerated
  ONCE on the GUI thread at window creation
  (`FontConfiguration::list_system_fonts`) and stashed in a process-global
  (`set_available_fonts`); `wtinator`/`wtinator-config` never depend on
  `wezterm-font` — names cross as plain strings.
- `notify_pipe.rs`: the apply closure runs the mux-side `f()` then
  `_tw.apply_pane_font_scale_change()` (needed so a *same-size* family change
  clears the shape caches and recomputes geometry).
- `wtinator-config` (React): a font-family `<select>` in pane mode, seeded from
  the pane's current override; `commitFontFamily` sends `set_pane_font_family`.

### Persistence — `wtinator/src/session.rs`
`PaneEntry` gains `font_family: Option<String>` (SESSION_VERSION bumped).
`session_restore` restores `set_font_family`; `ensure_pane_geometry` then
re-derives the cell aspect on the first paint (the mux-only restore path has no
font metrics).

## Pitfalls (what did NOT work — keep for the next person)

1. **`config::overridden_config({font, font_size})` silently drops the
   override.** It re-reads the config FILE from disk and the values never took,
   so every pane froze at the base cell (per-pane size AND family both dead).
   Fix: clone the in-memory window config (`with_font_family`) and scale with
   `change_scaling` — never `overridden_config` for a per-pane build.
2. **A 3-writer `cell_scale` (seed in `set_font_scale` + per-paint render push +
   apply recompute) racing each other** regressed per-pane size. Fix: one
   GUI-derived value (`family_ratio`), forced to `(1,1)` for window-font panes,
   with `font_scale` left as the sole size source.
3. **Reflow staleness:** size/family changes via restore/split/resize don't go
   through `apply`, so the grid stayed stale and content overflowed. Fix:
   `ensure_pane_geometry` self-heal in `paint_pass`.
4. **The cursor glide** mid-screen jumps on overridden panes — disable the glide
   for them.
5. **Non-monospace / icon fonts** resolve to a tiny/degenerate cell — guard and
   fall back. (The picker still lists all system fonts; a monospace filter is a
   TODO — see below.)

## Build / test

```
# Perl MUST be on PATH (openssl-sys); GUI must be closed (exe lock).
export PATH="/c/Strawberry/perl/bin:$PATH"
cargo +nightly build --release -p wezterm-gui -p wtinator-config \
  --manifest-path upstream-wezterm/Cargo.toml
```
Manual: `run-wezterminator-release.cmd`, right-click → Configure this terminal →
pick a font + size; verify only that pane changes, the grid fits its rectangle,
the cursor stays on its cell, and the choice survives a restart.

## Follow-ups (not in this patch)
- **Monospace filter** for the font picker. `ParsedFont` exposes no
  fixed-pitch/monospace flag, so a non-monospace pick currently falls back to
  the window font with no feedback ("I picked X, got Y"). Options: probe each
  font's advances at enumerate time (costly), a blocklist, or report the
  fallback back to the config window.
- Restore the cursor glide for overridden panes by making its pixel math
  metric-aware instead of disabling it.
