# Patch 0051 — Shape cache leaked fonts across per-pane-font panes

**Status:** Implemented 2026-06-14. Fixes a regression introduced by the
per-pane font work (patches 0039 / 0043 / 0047).

## Symptom

Random words rendered in the **wrong typeface** — most of a pane was the
correct monospace font, but an occasional word (e.g. the cmd.exe banner's
"reservados.") showed up in a serif / proportional face. It was
deterministic per word, appeared **even in panes with no per-pane font
override**, and looked different from one paint to the next ("fontes
estranhas, inconsistentes"). Reported with two screenshots: a light
`arc-light` pane (IntelOne Mono, bold, 0.75×) and a dark window-default
pane both showed the same serif "reservados.".

## Cause

`TermWindow::shape_cache` is a **single, window-level** cache shared by
every pane, keyed by `ShapeCacheKey { style, text }`. Upstream that is a
sufficient key because a window has exactly **one** font.

The per-pane font feature broke that invariant: `render/pane.rs`
**scope-swaps `self.fonts` / `self.render_metrics`** to the pane's
override font for the duration of that pane's line render (the shaper
reads `self.fonts` with no per-pane parameter). So two panes shape the
**same `(style, text)`** against **different fonts** — but produce the
**same cache key**. Whichever pane painted the run first stored its
rasterized glyphs (`Rc<CachedGlyph>` for a specific font + size) under
`{style, text}`, and every other pane that rendered the same text got a
cache **hit** and reused those foreign glyphs. The per-word randomness is
the LRU: each word is "claimed" by whichever pane happened to shape it
first that frame.

(The serif specifically came from the IntelOne-Mono-**bold** pane's font
resolution; with the leak it bled into the plain window-font pane too.)

The higher-level `LineToEleShapeCacheKey` (whole shaped line) was already
partitioned by `pane_font_scale` + `pane_font_family` (patches 0039 /
0043) so the two panes always **missed** there — but the miss rebuild
calls `cached_cluster_shape`, which hit the under-keyed `shape_cache`.
That same key was **missing `bold` / `italic`** (added to the pane in
patch 0047 but never to this key), so same-family/same-size panes that
differ only in weight/slant could also collide at the line level.

## Fix

1. **`ShapeCacheKey` / `BorrowedShapeCacheKey`** gain
   `font_id: LoadedFontId` — the identity of the resolved font the run was
   shaped with. This mirrors `GlyphKey::id`, which already partitions the
   **glyph** cache correctly (that cache was never affected).
2. **`cached_cluster_shape`** resolves the font **up-front** (it already
   did, just on the miss branch) and puts `font.id()` in the key, so each
   pane's shaped run lives in its own cache slot. The resolve is a cheap
   memoized `FontConfiguration::resolve_font` lookup and only runs on a
   line-to-element cache miss (a changed line).
3. **`LineToEleShapeCacheKey`** gains `pane_font_bold` / `pane_font_italic`
   (populated from `render/pane.rs`), closing the patch-0047 gap.

Window-default panes all resolve the same (un-swapped) `self.fonts`, so
they share one `font_id` and keep sharing cache entries — no perf
regression for the common case.

## Files

- `wezterm-gui/src/shapecache.rs` — `font_id` on both key structs +
  `to_owned` / `key()`.
- `wezterm-gui/src/termwindow/render/mod.rs` — `cached_cluster_shape`
  keys by `font.id()`; `LineToEleShapeCacheKey` gains bold/italic.
- `wezterm-gui/src/termwindow/render/pane.rs` — thread `pane_font_bold` /
  `pane_font_italic` into `LineRender` and the line shape key.

## Build

```
cargo +nightly build --release -p wezterm-gui   # Perl on PATH
```

## Verify

Open two panes side by side: one with a per-pane font override (e.g.
IntelOne Mono, bold, smaller) and one at the window default. Print the
same text in both (the cmd.exe banner is a good repro). Each pane must now
render **entirely in its own font** — no word borrows the other pane's
typeface.
