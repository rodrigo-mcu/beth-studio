# 0169 — The tray icon must not leak GDI objects

**Status:** Implemented 2026-09-25.

## Symptom

After about a day of use the tray menu, the right-click menus and the
menu icons stopped appearing. Clicks on the tray icon were logged
(`gui tray icon left click`) but no menu opened. The terminals kept
running in the host.

`GetGuiResources(GR_GDIOBJECTS)` on the GUI read **9999** (peak 10001):
the per-process GDI limit. A fresh GUI grew **+3 GDI objects every
15 s**, exactly the tray watchdog period (`TRAY_ICON_WATCH_MS`,
patch 0145).

## Cause

`taskbar_icon::tray_icon()` called `LoadImageW` (without `LR_SHARED`)
or built the badged icon on every call. `notify_icon` calls it on every
`NIM_MODIFY`, and the watchdog does a `NIM_MODIFY` every 15 s. The
returned `HICON` (colour + mask bitmaps) was never destroyed.
`Shell_NotifyIconW` copies the icon, so the handle was garbage right
after the call.

## Fix

`tray_icon()` caches the plain and the badged icon in two statics and
returns the cached handle. A failed load is not cached. Two threads
racing on the first load keep one icon and destroy the other.

## Recovery without losing terminals

A GUI already at the limit cannot free the handles. Run
`bethterm gui-restart`: only `bethterm-gui.exe` restarts, the host keeps
every PTY and the new GUI reattaches.

## Files

- `wtinator/src/taskbar_icon.rs`

## Revert

Restore the uncached `tray_icon()` body. Remove row 0169 and this file.
