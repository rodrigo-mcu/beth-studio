# Patch 0083 — Compare GUI config paths with matching types

**Applied:** 2026-08-30

## What

Normalize `WEZTERM_CONFIG_FILE` to `PathBuf` before comparing it to the GUI
version handshake's `config_file_path`.

## Why

The handshake returns `Option<PathBuf>` while the environment read had produced
`Option<OsString>`, causing `wezterm-gui` to fail compilation with E0308.

## Files

- `wezterm-gui/src/main.rs`
- `PATCHES.md`

## Revert

Restore the `OsString` conversion, delete this file, and remove the 0083 entry
from `PATCHES.md`.
