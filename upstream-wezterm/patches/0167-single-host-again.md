# 0167 — One host again, with automatic recovery

**Status:** Implemented 2026-09-23. Reverts the behavior of 0159.

## Why

0159 ran one `bethterm-host.exe` per window. Its only gain was to
isolate a host crash, and no host crash was ever seen. It caused:

- restore spawning into many hosts: duplicated startup tabs, splits
  collapsed to 1 column
- a GUI that closed when a window host took over 8 s to start
- hosts left running with 0 panes, stale sockets
- a hidden "Connecting..." window per host (fixed in 0165)

## What

- `bethterm_hosts::attach()`: the GUI starts the single host
  (`ensure_running`) and makes `bethterm-host` the default domain. Window
  hosts left over from 0159 builds are attached (not default) so their
  terminals stay reachable. A host that fails to start is logged and
  the GUI keeps running on the local domain instead of exiting.
- `spawn.rs`, `session_restore.rs`, `main.rs`: no per-window host;
  spawn, split, and restore use the default domain.
- **Restore when the host came up empty.** `skip_host_session_respawn`
  now only checks `host_had_existing_panes()`. A GUI restart with a
  live host still applies metadata only. A host that lost its
  terminals gets `session.json` respawned, with each pane's command
  (0161, so WSL comes back as WSL). The 0123 panic is handled as a
  skip.
- **Automatic recovery.** `bethterm_hosts::on_mux_empty()` handles the
  empty mux in one place:
  - tray Sair / Encerrar requested: quit
  - a host died with terminals (connection lost while panes were
    shown, pid file still there): `recover()` starts the host again,
    reattaches, re-arms the startup restore, and opens a window whose
    `created` hook restores `session.json`. At most 3 recoveries in 10
    minutes.
  - otherwise the user closed every terminal: clear `session.json`,
    stay in the tray
  Repeated Empty notifications within 3 s are ignored.

Tested in isolation (APPDATA in a temp folder):

- restore of 3 tabs (2 WSL): one host, 3 panes, no duplicate tab
- quit event set by an unknown process: host restarted and the 3 tabs
  restored within 1.5 s
- all terminals closed: session cleared, host kept, GUI in the tray; a
  second launch handed off and opened a window

## Files

- `wezterm-gui/src/{bethterm_hosts,main,spawn,frontend}.rs`
- `wezterm-gui/src/termwindow/session_restore.rs`
- `wtinator/src/{host,session}.rs`

## Revert

Restore the 0159 versions of `bethterm_hosts.rs`, `attach_bethterm_host`,
the `open_new` calls in `spawn.rs`, `session_restore.rs`, and `main.rs`,
the 0165 Empty handler, and `skip_host_session_respawn`. Remove
`rearm_startup_restore`, row 0167, and this file.
