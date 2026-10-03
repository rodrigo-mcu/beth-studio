# 0120 — Tray menu keeps visible terminals in the list

**Status:** Implemented 2026-09-16.

## What

Right-click on the notification-area icon listed only windows hidden
to the tray. After restore they disappeared, so focusing one of many
visible terminals meant hunting the Windows taskbar.

The picker now lists **every live BethTerm window**: hidden first
(newest first), then visible. Clicking a row raises that window
(restore if iconic/hidden, then foreground). "Abrir todas" still
only appears when more than one window is hidden.

## Files

- `wtinator/src/tray.rs`

## Revert

Build the menu from `state.hidden` only and restore via
`restore_display_index`.
