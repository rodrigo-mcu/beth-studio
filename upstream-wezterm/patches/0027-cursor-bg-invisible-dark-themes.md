# Patch 0027 — Fix invisible cursor in built-in dark themes

**Applied:** 2026-06-07
**Files:**
- `upstream-wezterm/wtinator/src/vscode_theme.rs`

**Status:** Active

## What

The two baked-in dark schemes (`vscode_dark`, `windows_terminal_dark`)
set `cursor_bg = background`, which made the default `BlinkingBlock`
cursor effectively invisible: wezterm paints the whole cell with
`cursor_bg`, so the cursor block had the same colour as the cells
around it. The cursor *was* there, but it blended into the background.

The user-reported symptom was:

> "qd o eu mudo de terminal o cursor some, mas se eu digitar funciona,
> mas o cursor some, num dá pra ver ele"
> "é erro no tema VSCODE DARK, ele some com o cursor"

Both observations make sense with the diagnosis:

- The cursor *is* painted, but with `cursor_bg == background`, so the
  block is the same colour as the surrounding cells. The blinking
  phase flips between the cursor colour (visible) and the background
  (invisible), and because the dark cursor colour is a light grey
  (`#AEAFAD`) sitting on a near-black background (`#1E1E1F`), the
  "off" phase is much longer than the "on" phase at the default blink
  rate — the user perceives the cursor as "vanished" while the rest
  of the application continues normally.
- Typing restarts the blink timer (`prev_cursor.bump()`), so the
  cursor briefly becomes visible on each keypress, then fades back
  out — the user reads this as "se eu digitar funciona".

## Why patch 0024 did not fix it

Patch 0024 (`wtinator::cursor_color`) emits a `colors.cursor_fg`
override that is bright/contrasty against the background. But the
`BlinkingBlock` render path uses `cursor_bg` for the *block fill*
(see `wezterm-gui/src/termwindow/render/mod.rs:629-643`) and only uses
`cursor_fg` for the *text on top of the block*. Setting a bright
`cursor_fg` did not help the block itself stay visible.

## Fix

Mirror what `vscode_light()` already does — set `cursor_bg = cursor`
so the block is a visible filled rectangle in the cursor colour
(`#AEAFAD` for `vscode_dark`, `#FFFFFF` for `windows_terminal_dark`).
This is also what VSCode's own Default Dark Modern paints for the
editor cursor (a solid light-grey block).

```rust
// before (broken):
cursor_fg: cursor,
cursor_bg: bg,        // == background → invisible block
cursor_border: cursor,

// after (fixed):
cursor_fg: cursor,
cursor_bg: cursor,    // solid fill in the cursor colour
cursor_border: cursor,
```

## Regression test

`vscode_theme::tests::cursor_bg_must_contrast_with_background`
asserts `cursor_bg != background` for both dark schemes, so this bug
cannot regress without a test failure.

## Revert

1. In `wtinator/src/vscode_theme.rs`, change `cursor_bg: cursor` back
   to `cursor_bg: bg` in both `vscode_dark()` and
   `windows_terminal_dark()`.
2. Delete the `cursor_bg_must_contrast_with_background` test.
3. Remove this file and the row for patch 0027 from `PATCHES.md`.

## Risk

Low. The change is a single per-palette assignment; the palette is
fed into `TermWindow::set_color_scheme` exactly as before. Users who
set `colors.cursor_bg` in their own `wezterm.lua` still win because
the user config is merged after the baked-in palette.
