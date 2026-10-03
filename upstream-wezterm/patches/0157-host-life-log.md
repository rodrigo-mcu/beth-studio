# 0157 — The host writes why it exited

**Status:** Implemented 2026-09-23.

## What

On 2026-09-23 the host process ended at 11:17 and took every shell
with it. Windows recorded no crash. The only intentional exit is
`process::exit` after the quit event, and that path did not flush a
line, so the log could not say why.

`%APPDATA%\bethterm\host-life.log` is appended and synced:

- host became the PTY owner
- `alive panes=N` once a minute
- GUI confirmed **Encerrar host** (includes the GUI pid) before the
  signal
- quit event received, including when it was already signaled at start
- `TerminateProcess` if the event did not stop the host in 5 seconds
- a panic, via the host panic hook
- a second host exiting because one is already running
- GUI restart and GUI quit (those do not stop the host)

The GUI log also records an explicit error when the host socket
closes.

## Files

- `wtinator/src/host.rs`, `wtinator/src/tray.rs`
- `wezterm-mux-server/src/main.rs`
- `wezterm-client/src/domain.rs`

## Revert

Remove `note_life`, the heartbeat, and the panic hook. Remove row
0157 and this file.
