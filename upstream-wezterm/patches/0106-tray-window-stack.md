# 0106 — Tray menu stacks hidden windows

## What

Patch 0105 hid the title-bar X to a single notification-area icon, but the
right-click menu only had **Abrir** (restore everything) and **Sair**.

This patch stacks every hidden window in that menu so the user can open
one of them:

- Right-click: one entry per hidden window (newest on top), then
  **Abrir todas** when more than one is hidden, then **Sair**.
- Left-click: restore the only hidden window, or open the same picker
  when several are stacked.
- Double-click: restore the most recently hidden window.
- Window names prefer the sticky window title, then the mux/tab title.
- Separate BethTerm processes (`--always-new-process`, extra shortcuts)
  share one tray owner through a named mutex + `WM_COPYDATA`. `ShowWindow`
  restores a window that belongs to another process. **Sair** marks each
  HWND with a window property so the other process really quits instead of
  hiding again.

PTYs keep running while hidden.

## Files

- `wtinator/src/tray.rs`
- `wtinator/Cargo.toml`
- `wezterm-gui/src/termwindow/mod.rs`

## Revert

Restore the 0105 tray menu (Abrir / Sair, restore-all only) and drop the
Threading feature if nothing else needs it.
