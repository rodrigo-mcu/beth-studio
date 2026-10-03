# 0159 — One host process per window

**Status:** Implemented 2026-09-23. **Reverted by 0167** (one host again).

## What

A single `bethterm-host.exe` owned every PTY. When that process
exited, every conversation that lived only in its memory went with
it.

Each new window now starts its own host:

- id in `BETHTERM_HOST_ID`
- socket `%APPDATA%\bethterm\hosts\<id>.sock`
- mutex `Local\BethTermHost-<id>`
- quit event `Local\BethTermHostQuit-<id>`

The GUI process is still one. The tray icon next to the clock still
lists every window, hides them, restarts the interface, and chooses
GPU or CPU. **Encerrar BethTerm** is the entry that stops every
window host, and it still asks first.

On startup the GUI reattaches every host that is still running, so a
GUI restart does not spawn a second set of panes. A host that dies
drops only the panes it owned.

`host-windows.json` records the domain name in `host_id` so pane ids,
which start at 1 in every host, are not mixed across windows. Older
records without `host_id` still match the legacy name `bethterm-host`.

## Files

- `wtinator/src/host.rs`, `wtinator/src/window_geom.rs`
- `wezterm-gui/src/bethterm_hosts.rs` (new)
- `wezterm-gui/src/main.rs`, `wezterm-gui/src/spawn.rs`
- `wezterm-gui/src/termwindow/session_restore.rs`
- `wezterm-mux-server/src/main.rs`

## Revert

Restore the single `host.sock` and the one mutex. Remove
`bethterm_hosts.rs` and the `host_id` field. Remove row 0159 and this
file.
