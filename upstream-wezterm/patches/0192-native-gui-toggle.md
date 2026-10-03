# 0192 — Turn the native terminal window off

**Status:** Implemented 2026-09-27.

## What

The tray menu **Interface gráfica** turns the native terminal window
on or off. On is the default (a missing file is on).

Off saves `%APPDATA%\bethterm\native-gui` as `off` and restarts only
`bethterm-gui.exe`. The new process still owns the icon next to the
clock, still attaches to the host, and does not create a terminal
window, so the OpenGL renderer does not start. The host, the shells,
Beth Studio, and Sistema keep running.

**Novo terminal** still starts a shell on the host (Beth Studio lists
it) and does not open a drawing window. **Painel** is grayed out,
because it is drawn inside a terminal window. A second click on the
shortcut does not open a window while this is off. Turning the entry
back on restarts the interface and the windows return.

## Files

- `wtinator/src/native_gui.rs` (new), `wtinator/src/lib.rs`, `wtinator/src/tray.rs`
- `wezterm-gui/src/main.rs`, `wezterm-gui/src/frontend.rs`
- `wezterm-gui/src/termwindow/render/dashboard.rs`

## Revert

Remove the module, the menu entry, the startup tray init, and the
frontend skip. Remove row 0192 and this file.
