# Patch 0053 — Cursor glide guard must also cover bold/italic panes

**Status:** Implemented 2026-06-14. One-line follow-up to patches 0047
(per-pane bold/italic) and 0052 (style now actually applies).

## Symptom

After setting a pane to **bold** or **italic**, the cursor jumped to a
strange location (e.g. the bottom-left corner, detached from the prompt) —
"olha onde o cursor foi parar".

## Cause

The cursor **glide** (patch 0044) interpolates the cursor's pixel rect
across frames, tuned for the uniform **window** cell. Patch 0043 already
disables the glide for a pane whose font is overridden, because a different
cell size makes the interpolation unstable (the cursor "shoots to the middle
of the screen"). But that guard only checked:

```rust
if (pos.pane.get_font_scale() - 1.0).abs() > 0.0001
    || pos.pane.get_font_family().is_some()
{ return None; }
```

It did **not** check `get_font_bold()` / `get_font_italic()`. Patch 0047
added bold/italic to the pane but never updated this guard — the same
"styled" gap that patch 0051 fixed in the shape-cache keys. Once patch 0052
made bold/italic actually change the rendered cell (bold widens, italic
skews), a bold/italic pane has a different cell shape than the window cell,
so the still-running glide mis-interpolated and parked the cursor off-cell.

## Fix

Add bold/italic to the guard, matching the "styled" set used by
`apply_pane_font_scale_change` (`family.is_some() || bold || italic`):

```rust
if (pos.pane.get_font_scale() - 1.0).abs() > 0.0001
    || pos.pane.get_font_family().is_some()
    || pos.pane.get_font_bold()
    || pos.pane.get_font_italic()
{ return None; }
```

The pane then renders the normal per-cell cursor at its own scaled metrics
(which lands exactly on the cell). The glide still runs for window-font
panes.

## Files

- `wezterm-gui/src/termwindow/render/pane.rs` — `update_cursor_glide` guard.

## Build / verify

```
export PATH="/c/Strawberry/perl/bin:$PATH"
cargo +nightly build --release -p wezterm-gui
```

Set a pane bold/italic and type: the cursor must stay on the current cell
next to the text, not jump elsewhere.
