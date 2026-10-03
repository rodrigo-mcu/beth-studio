# 0109 — Focus existing GUI; hide WGL probe window

## What

Clicking the BethTerm shortcut while a GUI was already running spawned
another full window. Combined with the leaked OpenGL "wezterm wgl
extension probing window" (`WS_OVERLAPPEDWINDOW` 1024×768, never
destroyed), the taskbar filled with `wezter...` buttons.

- Shortcut attach (`start` without `--new-tab`) now focuses/restores the
  running `bethterm-gui.exe` instead of `spawn_v2`.
- WGL probe uses `WS_POPUP` + `WS_EX_TOOLWINDOW`, 1×1, then
  `DestroyWindow`.

`--new-tab` still spawns a tab in the existing GUI.

## Files

- `window/src/os/windows/wgl.rs`
- `wtinator/src/tray.rs`
- `wezterm-gui/src/main.rs`

## Revert

Restore the overlapped probe window and the `spawn_v2` path in `try_spawn`.
