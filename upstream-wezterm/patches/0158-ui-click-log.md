# 0158 — Menu and window-control clicks are logged

**Status:** Implemented 2026-09-23.

## What

The host exit on 2026-09-23 left no click trail. The same synced
file `%APPDATA%\bethterm\host-life.log` now records:

- tray icon left click and right click
- every tray menu command by name, including Encerrar host and
  whether the confirmation was accepted
- title-bar Hide, Maximize, Restore, and Close
- a close that only hides the window to the tray
- right-click menu opened, the item chosen, or dismissed

A later host death can be read against the last click.

## Files

- `wtinator/src/tray.rs`, `wtinator/src/context_menu.rs`
- `wezterm-gui/src/termwindow/mouseevent.rs`
- `wezterm-gui/src/termwindow/mod.rs`

## Revert

Remove the `note_life` calls added here and `describe_action`. Remove
row 0158 and this file.
