# 0134 — Session auto-save only when something changed

**Status:** Implemented 2026-09-21.

## Symptom

The 30 s auto-save (patch 0029/0113) rewrote `%APPDATA%\bethterm\
session.json` on every tick and logged `snapshot captured …` at INFO,
even with nothing changed. With more than one `TermWindow` alive the
timer ran once per window: the log showed the same line 2–3 times per
tick and AppData was written 2–3 times every 30 s.

## Fix (`wtinator/src/session.rs`)

- `persist_session` serializes the snapshot and compares it with the
  bytes of the last write (`LAST_WRITTEN`). Equal → no disk I/O, a
  DEBUG line only. Different → one INFO line `session changed; saving`
  and the write as before. Applies to both the timer and explicit
  `save()` calls.
- Background auto-saves carry a rate guard (`LAST_AUTO_SAVE`, 20 s):
  when several 30 s timers exist, only the first tick in that window
  does the mux walk. The timer itself lives in
  `wezterm-gui/src/termwindow/mod.rs` and is untouched; the duplicate
  windows that start it are a separate issue.
- `snapshot()` logs at DEBUG.

## Files

- `wtinator/src/session.rs`

## Verification

`cargo +nightly test -p wtinator --lib session` — includes
`unchanged_bytes_are_skipped_until_they_change` and
`auto_save_rate_guard_collapses_duplicate_timers`.

## Revert

Drop the two statics, the two helpers and their calls in
`persist_session`; restore the INFO log in `snapshot()`. Remove this
document and row 0134 from `PATCHES.md`.
