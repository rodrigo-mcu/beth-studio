# 0094 — Shortcuts launch the GUI, not the CLI console

## What

Installer shortcuts used to target `bethterm.exe` with
`start --always-new-process`. That binary is the console CLI (same as
`wezterm.exe`); Windows therefore opened a console and the GUI logged into
it.

Shortcuts now target `bethterm-gui.exe` (`windows_subsystem = "windows"`).
The PowerShell that writes the `.lnk` is started with `CREATE_NO_WINDOW`.

## Revert

Restore `TargetPath = bethterm.exe` in `native_lnk::write`.
