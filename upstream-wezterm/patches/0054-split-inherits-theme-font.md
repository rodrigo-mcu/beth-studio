# Patch 0054 — A split inherits the source pane's theme + font

**Status:** Implemented 2026-06-14.

The user asked: "qdo fizer split é bom 'herdar' o tema de onde clicou" — a
new split should look like the pane it grew from.

## Behaviour

When a pane is split (right-click → Split right/down, or the split key
assignments), the new pane now **inherits** the source pane's per-pane
appearance:

- **Theme** — only if the source has an **explicit** per-pane theme override
  (`get_theme_id().is_some()`). A pane on the window default splits into a
  default pane, so it keeps following the window theme rather than freezing a
  copy of the current colors.
- **Font** — size scale, family, bold, italic (copied as-is; defaults are a
  no-op).

The source is the tab's **active pane** (`tab.get_active_pane()` in
`spawn.rs::SpawnWhere::SplitPane`), which is the pane you're working in when
you split via keyboard, or the one you right-clicked when it is the active
pane (the usual case).

## Implementation

`wezterm-gui/src/spawn.rs`, `SpawnWhere::SplitPane`: capture the source
pane's `theme_id` + `palette()` + `font_scale`/`font_family`/`font_bold`/
`font_italic` **before** `mux.split_pane(...)`, then apply them to the
returned new pane with `set_theme_id` / `set_palette` / `set_font_*`.

No explicit reflow/apply call is needed from this (non-`TermWindow`) spawn
path: `ensure_pane_geometry` (run at the top of every `paint_pass`) already
covers split-created panes — it recomputes the new pane's family aspect and
reflows it to the inherited font on the next paint — and the palette is read
directly during paint. The split already triggers a `window.invalidate()`.

## Notes / possible follow-ups

- The source is the **active** pane. If you right-click a **non-active** pane
  and split, the split (an upstream behaviour) still grows from the active
  pane, so it inherits from the active one. Making right-click splits target
  the clicked pane would mean activating it first in the `PerformAssignment`
  handler — deferred unless it's wanted.

## Files

- `wezterm-gui/src/spawn.rs`

## Build / verify

```
export PATH="/c/Strawberry/perl/bin:$PATH"
cargo +nightly build --release -p wezterm-gui
```

Give a pane a theme + font, split it → the new half comes up with the same
theme and font. Split a default pane → the new half is default.
