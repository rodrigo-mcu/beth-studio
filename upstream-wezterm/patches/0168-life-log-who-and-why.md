# 0168 — host-life.log says who did what

**Status:** Implemented 2026-09-23.

## Why

On 2026-09-23 the host logged `quit event signaled; exiting` at
11:56:22. Nothing recorded who set the event, so it could not be
proven whether it was the tray, the setup, or something else.

## What

`%APPDATA%\bethterm\host-life.log` (synced on every line):

- **Role on every line:** `gui`, `host`, `host[<id>]`, `setup`, `cli`.
  The file rotates to `host-life.1.log` above 4 MB.
- **Who asked for a stop.** Before setting the quit event, the tray
  and the setup write `<socket>.quit-request`
  (`host.quit-request`) with time, pid, exe, and reason. The host logs
  it when it exits: `requested by: ... reason=...`. Without the file
  it logs `requester UNKNOWN ... another program or an agent script`.
  A stale request is removed when a host starts.
- **Host start:** exe path, build time, and parent process.
- **Every pane opened/closed** in the host, with the running count.
- **GUI start** (exe, build, parent), **GUI exit** (message loop end,
  startup failure), **GUI panics**, second launch handed off or not
  (and why a second GUI started).
- **GUI view of the host:** attached to pid N; lost the connection
  (panes shown); domain detached; the host's exit code with its
  meaning (`clean exit`, `killed by taskkill / TerminateProcess`,
  `CRASH: access violation`, ...), via a handle waited on in a thread.
- **Setup:** install started (build, source exe, destination,
  hosts_running, host_changed, stop_all, close_host), every quit it
  signals with the reason, every process "Encerrar tudo" terminated,
  install finished / failed.

Tested: an anonymous `SetEvent` on `Local\BethTermHostQuit` logged
`requester UNKNOWN`, the GUI logged the lost connection and exit code
`0x0 (clean exit)`, then the recovery lines of 0167.

## Files

- `wtinator/src/host.rs`, `wtinator/Cargo.toml` (`chrono`)
- `wezterm-gui/src/main.rs`, `wezterm-client/src/domain.rs`
- `wezterm-mux-server/src/main.rs`
- `bethterm-setup/src/main.rs`, `bethterm-setup/Cargo.toml`
  (`Win32_System_SystemInformation`)

## Revert

Remove `life_role`, rotation, `describe_*`, `write_quit_request` and
its callers, the quit-request read in the quit watcher,
`log_pane_changes`, `watch_host_exit`, `exit_code_meaning`,
`BETHTERM_LIFE_LOG`, the GUI start/exit/panic lines, and the setup
`life` calls. Remove row 0168 and this file.
