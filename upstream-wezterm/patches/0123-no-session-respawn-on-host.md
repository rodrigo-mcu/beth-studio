# 0123 — Do not respawn session.json onto the host

**Status:** Implemented 2026-09-16.

## What

A second GUI (`start --always-new-process`) attached to
`bethterm-host` and then `restore_session` spawned tabs from
`session.json` on the ClientDomain. That panicked at
`primary window to be valid` and the new window vanished.

If the default domain is the host, skip that respawn. Apply
metadata only. Also treat a missing primary window as a skip
instead of a panic.

## Files

- `wezterm-gui/src/termwindow/session_restore.rs`
- `wezterm-client/src/domain.rs`

## Revert

Restore the 0121 `host_had_existing_panes` check only, and the
`expect("primary window to be valid")`.
