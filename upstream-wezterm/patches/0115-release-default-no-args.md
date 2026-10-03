# 0115 — Release GUI is the default launch; no CLI args

**Status:** Implemented 2026-09-16.

## What

Daily launch is release `bethterm-gui.exe` with **no arguments**:

- New `run-bethterm.cmd` → `run-bethterm-release.cmd`
- Release launcher no longer passes `start --always-new-process` and
  no longer sets `WEZTERM_LOG`
- Installer Desktop/Start shortcuts have empty `Arguments`
- Setup **Abrir** spawns `bethterm-gui.exe` with no args

A second click focuses the existing GPU process (patch 0108).
`--always-new-process` stays only on `run-bethterm-debug.cmd`.

## Files

- `run-bethterm.cmd` (new)
- `run-bethterm-release.cmd`
- `bethterm-setup/src/main.rs`
- `AGENTS.md`

## Revert

Restore `start --always-new-process` on the release launcher and
`Arguments = 'start'` / `cmd.arg("start")` in the installer.
