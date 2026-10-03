# 0108 — Shortcuts reuse the running GUI

## What

Installer shortcuts and the setup **Abrir** button launched
`bethterm-gui.exe start --always-new-process`. Each click started a full
GPU process and made several windows freeze.

They now launch `start` only. A second click asks the running BethTerm to
spawn another window in the same process. A different executable (old
WezTerminator, system WezTerm) is still rejected by the mux version check
and starts its own process.

Existing Desktop/Start Menu `.lnk` files are rewritten on update even if
the shortcut checkbox is off.

Developer launchers (`run-bethterm-*.cmd`) keep `--always-new-process` so
test runs do not attach to a stale GUI.

## Files

- `bethterm-setup/src/main.rs`

## Revert

Restore `start --always-new-process` in `native_lnk::write` and
`launch_installed`.
