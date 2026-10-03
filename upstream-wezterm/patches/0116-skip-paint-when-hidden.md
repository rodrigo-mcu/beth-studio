# 0116 — Skip GPU paint when minimized or hidden in the tray

**Status:** Implemented 2026-09-16.

## What

While a BethTerm window is iconic (taskbar minimize) or hidden in the
notification area (`SW_HIDE`), skip GPU paint. The PTY, mux, and
session keep running so output is not paused and restore does not
stall ConPTY.

On restore (`show_hidden`, focus existing GUI), force a full
`InvalidateRect` so the first visible frame is current.

## Why

Paint and the `max_fps` timer burn GPU/CPU while nothing is on screen.
Pausing PTY instead would make restore and close hangs worse.

## Files

- `window/src/os/windows/window.rs` — `WM_PAINT` validates and returns
  when iconic or not visible; no `NeedRepaint` / paint throttle.
- `wezterm-gui/src/termwindow/mod.rs` — `NeedRepaint` and mux output
  skip `do_paint` / `invalidate` when the HWND is hidden or iconic.
- `wtinator/src/tray.rs` — `InvalidateRect` after `ShowWindow` on
  restore.

## Revert

Remove the iconic/hidden early-outs and the restore `InvalidateRect`.
