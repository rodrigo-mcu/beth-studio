# 0190 — SSH and serial sessions do not open a GUI window

**Status:** Implemented 2026-09-26.

## Why

`spawn_tool` (patch 0184) created the pane in the default workspace, or
inside the source pane's mux window when Beth Studio asked for a split.
The GUI opens a window for every mux window in its active workspace, so
an SSH session from Beth Studio also appeared in the BethTerm window.
The tray icon is the GUI process; quitting or hiding the GUI is not the
fix, because Beth Studio's terminals and the clock icon must stay.

## Change

`spawn_tool` always spawns into workspace `beth-studio` and ignores
`window_id`. The GUI reconciles only its active workspace (`default`),
so it does not create a window. `ListPanes` still returns every window,
so Beth Studio keeps the terminal. Local shells (`spawn`) are unchanged
and still show in the GUI.

## Files

- `wezterm/src/cli/bridge.rs` — `STUDIO_WORKSPACE`, `spawn_tool`

## Revert

Restore `spawn_tool` to use `config.default_workspace` and the client's
`window_id`. Remove row 0190 and this file.
