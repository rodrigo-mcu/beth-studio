# Patch 0052 — Per-pane family/bold/italic need a config swap, not just a fonts swap

**Status:** Implemented 2026-06-14. Fixes per-pane **bold / italic** (patch
0047) and, in the same stroke, makes per-pane **family** (patch 0043)
actually change the typeface rather than only the cell size.

## Symptom

Setting a pane to **bold** or **italic** in "Configure this terminal…" did
nothing visible. (Per-pane **size** worked; **family** appeared to "work"
but really only changed the cell metrics/size, not the glyphs' typeface.)

## Cause

The per-pane font override (`render/pane.rs::paint_pane`) scope-swaps
`self.fonts` and `self.render_metrics` to the pane's override values for the
content render. The assumption (patches 0039/0043) was that swapping
`self.fonts` is enough for the glyphs to pick up the override.

It is **not**. The glyphs' family / weight / slant are chosen by:

```rust
// render/screen_line.rs::build_line_element_shape
let style = self.fonts.match_style(params.config, attrs);
```

`FontConfiguration::match_style(config, attrs)` returns a `&TextStyle`
borrowed from the **`config` argument** — i.e. `params.config`, which is
`self.config` (the **window** config), NOT `self.fonts`. For a default cell
it returns `&config.font`. Then `resolve_font(style)` resolves the glyphs
from `style.font_with_fallback()` — the **style's** font list.

So swapping only `self.fonts`:
- **size** ✅ — `RenderMetrics` + `change_scaling` come from `self.fonts`, so
  the cell size changes.
- **family / bold / italic** ❌ — the resolved glyph family/weight/slant come
  from `match_style(window_config)`, which never saw the override.

`with_font_override` correctly builds a config whose **primary font** carries
the family + `FontWeight::BOLD` + `FontStyle::Italic`, but that config was
only ever reachable through `self.fonts`, not through `match_style`.

## Fix

In `paint_pane`, when the per-pane font swap is active, **also** swap
`self.config` to the pane's override config (`pane_fonts.config()`, the
`with_font_override` result) for the content render, and restore it on both
the ok and error paths alongside the fonts/metrics restore.

Now `match_style(params.config /* = override */, attrs)` returns the override
style for default cells, and `resolve_font` loads the override
family/bold/italic (synthesizing bold/italic via FreeType when the face lacks
them — `parser.rs::synthesize`).

The override config is a clone of the window config with the **same
`generation`** and only the font changed, so:
- caches don't churn (`config_generation` in the quad-cache key is unchanged;
  panes are already disambiguated by `pane_id` and the per-pane font fields in
  the shape-cache keys — patches 0039/0043/0047/0051);
- a **size-only** pane is unaffected (its override config keeps the window
  font, so `match_style` returns the window style exactly as before);
- the always-visible pane **header** renders before the swap, so it stays in
  the window font.

## Known limitation

`with_font_override` does not rewrite `config.font_rules`, so a cell the
*program* marks bold/italic (ANSI intensity / italic) still matches a window
font-rule and renders in the **window** family's bold/italic, not the pane's
chosen family. Default-intensity text — the overwhelming majority — uses the
override correctly. Rewriting the per-rule families is a possible follow-up.

## Files

- `wezterm-gui/src/termwindow/render/pane.rs` — swap + restore `self.config`
  next to the existing `self.fonts` / `self.render_metrics` swap.

## Build / verify

```
export PATH="/c/Strawberry/perl/bin:$PATH"
cargo +nightly build --release -p wezterm-gui
```

Right-click a pane → Configure this terminal → toggle **B** / **I** and pick a
family. The pane's normal text must visibly change weight / slant / typeface
(not just size), and only that pane.
