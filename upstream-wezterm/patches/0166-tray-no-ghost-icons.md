# 0166 — Tray watchdog no longer piles up icons

**Status:** Implemented 2026-09-23.

## What

The patch 0145 watchdog treated the icon as lost when
`Shell_NotifyIconGetRect` failed. On Windows 10 that call also fails
for an icon parked in the hidden-icons overflow (the ^ arrow). About
15 s after every start the log showed
`icon lost (listed=false, modify_ok=true); re-adding with a new id`,
then `rebuilding the tray window`.

The rebuild bumped the icon id before destroying the old window, so
the old window's `NIM_DELETE` used an id that was never added. The
icon it really held stayed next to the clock as a ghost, one more on
every cycle.

- `next_icon_action`: `NIM_MODIFY` succeeding proves the icon exists;
  the rect is no longer required. The re-add check uses the same test.
- `rebuild_tray_window`: removes the icon the old window holds before
  the id changes.

Tested: a GUI running 25 s after start logged no "icon lost".

## Files

- `wtinator/src/tray.rs`

## Revert

Restore `exists && modify_ok`, the `icon_exists` re-add check, and
drop the `remove_icon` call in `rebuild_tray_window`. Remove row 0166
and this file.
