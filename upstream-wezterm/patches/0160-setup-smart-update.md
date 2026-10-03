# 0160 — Setup shows the build time and does not kill hosts for a GUI-only update

**Status:** Implemented 2026-09-23.

## What

The installer header shows the build timestamp of the packaged
binaries (newest of `bethterm-gui.exe`, `bethterm-host.exe`,
`bethterm.exe`).

If a window host is running and `bethterm-host.exe` in the package is
identical to the installed one, the update replaces the GUI and leaves
every host alone. No question is asked.

If the host executable changed and a host is running, the setup asks:

- Sim: quit every window host, then update everything
- Não: update only the interface; hosts and their terminals stay
- Cancelar: do not update

Per-window hosts (`Local\BethTermHost-<id>`) are included, not only
the legacy single host.

## Files

- `bethterm-setup/src/main.rs`, `bethterm-setup/build.rs`, `bethterm-setup/Cargo.toml`

## Revert

Restore the unconditional host question and the fixed subtitle.
Remove row 0160 and this file.
