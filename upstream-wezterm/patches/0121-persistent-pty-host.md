# 0121 — Persistent PTY host

**Status:** Implemented 2026-09-16.

## What

GUI updates and **Sair** used to kill every shell because ConPTY lived
in `bethterm-gui.exe`. A second process, `bethterm-host.exe` (Cargo
package `wezterm-mux-server`), now owns the mux and PTYs.

- Socket: `%APPDATA%\bethterm\host.sock`
- Single instance: mutex `Local\BethTermHost` (taken before bind)
- GUI default domain becomes `bethterm-host` **after**
  `Publish::try_spawn`, so a second shortcut click still reuses the
  running GPU process
- Host starts with no pane; the GUI attaches and spawns
- If attach already imported panes, `session.json` applies metadata
  only and does not spawn duplicates
- Tray **Sair** still exits the GUI only; **Encerrar host**, theme/font
  reconnect, and staged host updates are patch 0122.

## Files

- `wtinator/src/host.rs` (new)
- `wtinator/src/lib.rs`
- `wezterm-mux-server/Cargo.toml`
- `wezterm-mux-server/src/main.rs`
- `wezterm-gui/src/main.rs`
- `wezterm-gui/src/termwindow/session_restore.rs`
- `bethterm-setup/build.rs`
- `pack-bethterm-setup.ps1`
- `install-bethterm-release.ps1`

## Revert

Remove the host crate wiring and GUI attach. Restore the mux-server
default binary name and the previous session-restore spawn path.
