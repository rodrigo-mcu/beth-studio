# 0104 — BethTerm screenshot Save-As filename

## What

The JPEG Save-As dialog suggested `wezterm-screenshot-<unix>.jpg`. It now
suggests `bethterm-screenshot-YYYYMMDD-HHMMSS.jpg`, opens in Pictures when
that folder exists, and selects the JPEG filter by default (`nFilterIndex = 1`).

The scrollback Save-As default is `bethterm-<title>-YYYYMMDD-HHMMSS.txt`.

## Files

- `wtinator/src/screenshot.rs`
- `wtinator/src/save_scrollback.rs`

## Revert

Restore `wezterm-screenshot-{unix}.jpg`, `nFilterIndex: 0`, and no
Pictures initial directory.
