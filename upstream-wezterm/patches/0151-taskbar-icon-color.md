# 0151 — Choose the taskbar icon color per window

**Status:** Implemented 2026-09-23.

## What

Every window used the same executable icon, so a row of taskbar
buttons could not be told apart. The right-click menu **Cor do ícone**
offers Padrão plus eight colors. The choice is applied with
`WM_SETICON` (big and small) and stored as `icon_color` on that
window's record in `host-windows.json`, so a GUI restart paints it
again.

## Files

- `wtinator/src/taskbar_icon.rs` (new), `wtinator/src/lib.rs`
- `wtinator/src/context_menu.rs`, `wtinator/src/window_geom.rs`
- `wezterm-gui/src/termwindow/mouseevent.rs`

## Revert

Remove the module, the menu submenu, the `icon_color` field and the
mouse handler. Remove row 0151 and this file.
