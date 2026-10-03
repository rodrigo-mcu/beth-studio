# Patch 0086 — New windows open maximized

**Applied:** 2026-09-05

## What

Moving a tab to a new window created a borderless `WS_POPUP` at the source
tab's cell size and showed it with `SW_NORMAL`. That size is typically the
maximized content of the source, then centered on the full monitor
(`rcMonitor`), so the new window covered the Windows taskbar and looked
misplaced.

WezTerminator now shows new physical windows with `SW_MAXIMIZE`. Patch 0066
already clamps maximize to the monitor work area (`rcWork`), so the taskbar
stays visible.

This applies to every new `TermWindow` in WezTerminator mode, including
**Move tab to → New window…**, drag-out, SpawnWindow, and extra session
windows.

## Files

- `wezterm-gui/src/termwindow/mod.rs`
- `PATCHES.md`

## Verification

```powershell
cargo +nightly check -p wezterm-gui
```

Manual: Move tab to → New window. The new window should fill the work area
and leave the taskbar visible. Restore still shrinks it; maximize still
respects the taskbar.

## Revert

Restore the `window.show()` call, delete this file, and remove the 0086
entry from `PATCHES.md`.
