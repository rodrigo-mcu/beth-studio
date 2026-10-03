# 0114 — Fluid UI: no debug paint log, cheap cursor, no glide

**Status:** Implemented 2026-09-16.

## Symptom

After the ConPTY hang fix (0113) the window could still *feel* stuck:
typing lagged, the caret smeared, scrolling hitching. Daily launches
used the release launcher with `WEZTERM_LOG=debug`.

## Cause

1. `run-bethterm-release.cmd` set `WEZTERM_LOG=debug`. Patch 0056 and
   `paint.rs` log every mouse/selection/paint at debug. Formatting those
   lines on the GUI thread is enough to miss frames.
2. Cursor EaseInOut fade + cursor glide requested extra GPU frames on
   every blink and every key.

## Fix

- Release launcher uses `WEZTERM_LOG=error`. Debug launcher keeps
  `debug`.
- Cursor blink uses `Constant` easing and `animation_fps = 1`.
- Cursor glide is off unless `BETHTERM_CURSOR_GLIDE=1`.
- `max_fps = 60` is pinned in the BethTerm override pass.

## Files

- `run-bethterm-release.cmd`
- `AGENTS.md`
- `wtinator/src/cursor_anim.rs`
- `wezterm-gui/src/termwindow/render/pane.rs`

## Revert

Restore `WEZTERM_LOG=debug` on the release launcher, EaseInOut blink,
and the unguarded glide path.
