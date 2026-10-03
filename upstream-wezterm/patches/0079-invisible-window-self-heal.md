# Patch 0079 — Invisible window self-heal

**Status:** Implemented 2026-08-22.

## Symptom

`wezterm-gui.exe` appears in the process list but no window is shown. This
showed up after Windows froze from a full disk: `%APPDATA%` I/O stalled for
minutes, and a later launch attached to the hung instance instead of opening
a new window.

## Cause

1. Session restore (`session.json`) ran **before** `window.show()`. A stuck
   `fs::read` on AppData starved the GUI so the HWND was never shown.
2. Direct `wezterm-gui.exe` launches reuse the existing mux. Connecting to a
   frozen GUI blocks with no visible window.
3. The WezTerminator borderless `WS_POPUP` can land off-screen after a crash
   during maximize.

## Fix

- Show the OS window first; then restore the session (2s read timeout;
  corrupt JSON quarantined to `session.corrupt-<unix>.json`; 15s restore cap).
- If the published GUI has no usable on-screen window, skip attach (2s
  timeout if attach is attempted).
- A dedicated OS thread `ShowWindow`s / `SetWindowPos`s the HWND onto the
  monitor work area if it is hidden, iconic, tiny, or off-screen.

## Revert

Remove `wtinator/src/window_heal.rs`, the `window_heal` module from
`wtinator/src/lib.rs`, and restore the previous `load()` / `try_spawn` /
`TermWindow::new_window` restore-before-show order.
