# 0147 — Restart only the GUI (terminals stay in the host)

**Status:** Implemented 2026-09-22.

## What

Since patch 0121 the PTYs live in `bethterm-host.exe`. Ending
`bethterm-gui.exe` and starting it again loses nothing: the new GUI
reattaches every terminal (verified live: 16 panes, 4 windows). This is
the cure for a GUI whose tray icon vanished or whose native menus
stopped appearing (patches 0145/0146 make that rarer).

- Tray entry **Reiniciar interface (terminais continuam)**, just above
  **Fechar janelas (terminais continuam)**. It spawns a detached
  `bethterm.exe gui-restart --wait-pid <own pid>` and then runs the
  normal `request_quit()` so this GUI exits cleanly.
- CLI `bethterm gui-restart [--wait-pid N]` (`wtinator::gui_restart`):
  with `--wait-pid` it waits up to 15 s for that pid to exit, then
  terminates it; without, it terminates every `bethterm-gui.exe` /
  `wezterm-gui.exe` except itself. **Never** `bethterm-host.exe`. Then
  it launches `bethterm-gui.exe` next to the CLI (fallback
  `wezterm-gui.exe`), detached, no arguments, and prints one line.

From any shell:

```
bethterm gui-restart
```

## Files

- `wtinator/src/gui_restart.rs` (new), `wtinator/src/lib.rs`
- `wtinator/src/tray.rs` (`ID_GUI_RESTART`, `TrayMenuEntry::RestartGui`,
  `request_gui_restart`)
- `wezterm/src/main.rs` (`SubCommand::GuiRestart`)

## Revert

Remove the module, the tray entry and the subcommand. Remove row 0147
and this file.
