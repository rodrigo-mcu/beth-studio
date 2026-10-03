# 0100 — Rename text stays visible

## What

Inline header rename on a light terminal used a navy band with
glyphs that followed the pane foreground (dark), so typed text
disappeared. Edit mode now picks ink/paper from the pane
background luminance (dark on pale blue, or white on navy).

The Win32 “Rename terminal” EDIT also dropped visual styles so
`WM_CTLCOLOREDIT` can force black text on a white field.

## Files

- `wtinator/src/header/mod.rs`
- `wtinator/src/header/win32_prompt.rs`
- `wezterm-gui/src/termwindow/render/pane.rs`

## Revert

Restore the previous `HEADER_EDIT_*` paint path and Explorer theme
on the EDIT control.
