# 0148 — Windows come back where they were, with their names

**Status:** Implemented 2026-09-22.

## Symptom

After a GUI restart (crash, `gui-restart`, update) the windows that
were side by side all opened in the same corner, and the window names
were shuffled between windows.

## Cause

Since patch 0121 the terminals live in the host and a GUI start
re-creates one OS window per host window.

- Nothing stored window placement. `window_heal` (patch 0079) then
  moved **every** new window to `(work.left+24, work.top+24)` with a
  clamped size, so they all landed on top of each other. It also undid
  the default maximize of new windows.
- `session.json` stored window names by enumeration index. The
  re-attach creates local windows in the host's order, which is not
  the order of the previous GUI, so the names moved.

## Fix

- New `wtinator::window_geom`: `%APPDATA%\bethterm\host-windows.json`
  holds, per OS window, the sorted **host pane ids** it shows (the
  stable key), the user title, and the `GetWindowPlacement` rectangle
  plus maximized / hidden-in-tray flags. Saved with every session
  snapshot (only when changed); records whose panes are gone are
  pruned.
- `TermWindow::created`: registers the HWND, looks up the record that
  shares the most host panes with the new window, applies the title to
  the mux window and the placement with `SetWindowPlacement`. A window
  remembered as hidden goes straight back to the tray. Without a
  record the old behaviour (maximize) stays.
- `window_heal` leaves a usable window alone and skips windows
  restored hidden.
- `session::apply` no longer applies index-based window names when the
  host-windows store exists.

## Files

- `wtinator/src/window_geom.rs` (new), `wtinator/src/lib.rs`
- `wtinator/src/session.rs`, `wtinator/src/window_heal.rs`
- `wezterm-gui/src/termwindow/mod.rs`

## Verification

- `cargo +nightly test -p wtinator --lib` (new: `best_match_*`,
  `store_roundtrips_*`).
- Manual: arrange two windows side by side, name them, restart the GUI
  with `bethterm gui-restart`: both return to their places with their
  names; a tray-hidden window stays in the tray.

## Revert

Delete the module and the four hooks; restore the unconditional heal
and the index-based names. Remove row 0148 and this file.
