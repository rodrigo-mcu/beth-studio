# 0165 — Closing every terminal: tray stays, session clears, hosts exit

**Status:** Implemented 2026-09-23.

## What

On 2026-09-23 the user exited every restored terminal. Then:

- the GUI quit and the tray icon disappeared
- `session.json` still listed 9 tabs (last auto-save), so the next
  start would bring them all back
- 8 window hosts stayed alive with 0 panes, for good
- clicking the shortcut again started a second GUI with a second
  tray icon

Fixes:

- **Stay in the tray.** `MuxNotification::Empty` no longer ends a
  BethTerm GUI. Tray "Sair" / "Encerrar BethTerm" still quit:
  `tray::should_really_quit` makes `FORCE_QUIT` sticky and
  `tray::quit_requested()` is checked on Empty.
- **Clear the session.** On Empty, when the startup restore already
  read `session.json`, no quit was requested, and no host died with
  panes, `session::save()` writes the empty session.
  "Died with panes" = the connection dropped (`client.rs` detach path,
  `ClientDomain::note_connection_lost`) while the GUI still showed
  panes, and the host's pid file (0162) is still there. A host that
  exits because it is empty removes its pid file first. The mux also
  detaches a domain when its last window closes, so that path does not
  count. `request_stop_id` keeps the pid file for the same reason.
- **Empty window hosts exit.** `host::exit_when_emptied` (window
  hosts only; the legacy host is unchanged): after the last pane
  closes it waits 2 s, checks again, removes its `.sock` / `.pid`, and
  exits. `prune_stale_host_files` runs when the GUI attaches hosts.
- **One GUI, one icon.**
  - `discovery::resolve_gui_sock_path`: Windows publishes only the
    socket file name. A launch from any other folder (the shortcut
    starts in the install folder) could not connect and started a new
    GUI. It now joins `RUNTIME_DIR`.
  - `window_heal::existing_gui_is_usable`: a GUI with no terminal
    window but a tray icon is usable (tray-only on purpose).
  - `tray::focus_existing_gui`: with no window to focus, it sends the
    new `new_window` tray IPC, which opens a terminal.
- `is_bethterm_host_domain` in `wezterm-client`: the patch 0136
  headless connect UI and the 0157 log compared the name to
  `bethterm-host` exactly and missed every window host (0159). Each new
  window opened a hidden "Connecting..." ghost window.

## Files

- `wezterm-gui/src/frontend.rs`, `wezterm-gui/src/bethterm_hosts.rs`
- `wezterm-client/src/{domain,client,discovery}.rs` (upstream)
- `wezterm-mux-server/src/main.rs`
- `wtinator/src/{host,session,tray,window_heal}.rs`

## Revert

Restore the Empty handler (quit when `quit_when_all_windows_are_closed`),
`resolve_gui_sock_path`, the exact name comparisons, and the pid file
removal in `request_stop_id`. Remove `exit_when_emptied`,
`prune_stale_host_files`, `any_died_with_panes`, `note_connection_lost`,
`startup_restore_claimed`, `quit_requested`, `owner_exists`, the
`new_window` IPC, row 0165, and this file.
