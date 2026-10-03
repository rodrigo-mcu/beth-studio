# 0150 — Tray menu "Esconder tudo"

**Status:** Implemented 2026-09-23.

## What

The notification-area menu lists every window and can open the hidden
ones ("Abrir todas"). It could not put them all away. **Esconder tudo**
hides every visible BethTerm window the same way the title-bar X does:
`SW_HIDE`, remembered as hidden so the visibility watchdog does not
pull them back, and listed on the icon. The host and the shells keep
running. Shown when at least one window is on screen, just above
"Abrir todas".

## Files

- `wtinator/src/tray.rs`
- `wtinator/src/window_geom.rs` (`note_hidden`)

## Revert

Remove the menu entry, `hide_all_visible` and `note_hidden`. Remove
row 0150 and this file.
