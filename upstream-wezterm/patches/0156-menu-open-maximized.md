# 0156 — Opening a window from the tray menu maximizes it

**Status:** Implemented 2026-09-23.

## What

Clicking a window in the notification-area menu (or "Abrir todas")
restored it at the size it had when it was hidden. A chat that had
been a small or off-screen window came back that way.

Both paths now use `SW_SHOWMAXIMIZED`. The host and the shells are
unchanged.

## Files

- `wtinator/src/tray.rs`

## Revert

Restore the old `was_maximized` / `SW_SHOW` choice in `show_hidden`
and `raise_window`. Remove row 0156 and this file.
