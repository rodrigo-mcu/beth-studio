# 0117 — Tray "Novo terminal" shows the shell picker

**Status:** Implemented 2026-09-16.

## Symptom

Right-click on the notification-area icon → **Novo terminal** spawned
the default program immediately. There was no list of cmd / PowerShell
/ WSL / Git Bash like the tab-bar `+` picker.

## Fix

**Novo terminal** is a submenu:

```text
Novo terminal ►  Padrão
                 ----------------
                 cmd.exe
                 PowerShell 5.1
                 …
```

`Padrão` keeps the old default-program path. The other rows use
`wtinator::context_menu::default_shells()` and spawn that command in a
new OS window (same mux path as patch 0111, plus args).

## Files

- `wtinator/src/tray.rs`
- `wezterm-gui/src/spawn.rs`
- `wezterm-gui/src/termwindow/mod.rs`

## Revert

Restore the flat `Novo terminal` item and `fn()` handler that always
called `spawn_default_window()`.
