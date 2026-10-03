# 0126 — Tray icon survives Explorer restart

**Status:** Implemented 2026-09-20.

## What

Windows drops notification-area icons when `explorer.exe` restarts
(or otherwise rebuilds the tray). BethTerm kept thinking the icon
was still registered (`icon_added = true`) and only called
`NIM_MODIFY`, so tray-hidden windows (no taskbar button) became
unreachable until the GUI was restarted.

While `bethterm-gui.exe` is alive:

1. Listen for the `TaskbarCreated` broadcast and `NIM_ADD` again.
2. If `NIM_MODIFY` fails, clear the flag and quiet-`NIM_ADD`.
3. A 15s timer runs the same health check (covers HWND_MESSAGE
   owners that miss the broadcast).

The icon is still removed only on tray-owner `WM_DESTROY` (process
exit). PTYs / `bethterm-host` are untouched.

## Files

- `wtinator/src/tray.rs`

## Revert

Drop `TaskbarCreated` registration, the icon watch timer, the
`NIM_MODIFY` → quiet re-add path, and `add_icon_quiet`.
