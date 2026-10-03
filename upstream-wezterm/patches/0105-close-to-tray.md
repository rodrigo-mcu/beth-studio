# 0105 — Close title-bar X hides to the notification area

## What

Clicking the window X (or Alt+F4) no longer kills the session. The window
is hidden with `SW_HIDE` and a BethTerm icon appears next to the clock.

- Left-click / double-click the icon: restore the window.
- Right-click: **Abrir** or **Sair**.
- **Sair** restores the window and runs the existing quit confirmation.

PTYs keep running while hidden.

## Files

- `wtinator/src/tray.rs` (new)
- `wtinator/src/lib.rs`
- `wtinator/Cargo.toml`
- `wezterm-gui/src/termwindow/mod.rs`

## Revert

Delete `tray.rs`, remove the module and Shell features, and restore
`close_requested_with_confirmation` to always show the Task Dialog.
