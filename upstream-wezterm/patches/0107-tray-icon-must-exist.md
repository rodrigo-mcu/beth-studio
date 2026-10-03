# 0107 — Tray icon must exist before hide succeeds

## What

Clicking the window X hid the HWND and returned success before
`Shell_NotifyIcon` ran. A 0×0 `CreateWindowExW` popup can also fail, so the
user saw no icon next to the clock and the next step was the real close
confirmation.

- Title-bar X / `WM_CLOSE` only *schedules* hide via `spawn_into_main_thread`.
  Doing `ShowWindow`/`CreateWindow` inside `WM_CLOSE` re-entered `WndProc`
  with `WindowInner` borrowed and killed the process (exit code 1).
- Tray owner HWND is created on a dedicated thread with its own message loop.
- Title-bar X never kills the session. Only tray **Sair** quits.

## Files

- `wtinator/src/tray.rs`

## Revert

Restore the 0106 tray window creation and the fire-and-forget `WM_TRAY_SYNC`.
