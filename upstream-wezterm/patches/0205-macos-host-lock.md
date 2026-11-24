# 0205 — macOS host lock, data dir, and shells

The Windows host takes a named mutex and exits on a named event. On macOS
that pair did not exist: `try_become_owner` always returned true, so a
second host would unlink a live socket, and a leftover socket from a crash
looked like a running host.

## What

- `wtinator/src/host.rs`: on Unix the single-instance lock is `host.lock`
  (or `hosts/<id>.lock`) held with `flock` for the process lifetime. A
  crash drops the lock. "Encerrar tudo" writes `host.quit`; the host's
  quit watcher exits on purpose and names the requester from
  `host.quit-request`, same as the Windows event. The pid file is still
  written. A stale pid that no longer names `bethstudio-host` is not
  killed.
- `wtinator/src/session.rs`: on macOS the data dir is
  `$HOME/Library/Application Support/bethstudio`, the same folder the
  Studio uses, so the socket and the Studio files are one place.
- `wtinator/src/shells.rs`: outside Windows the "Novo terminal" list is
  the user's shell, then `/bin/zsh` and `/bin/bash` when they exist.
  They start interactive, without `-l`: on macOS a login zsh sources
  `/etc/zprofile` (`path_helper`) and holds the first prompt for about a
  second. `shells.json` still appends.
- `wezterm-client/src/client.rs`: `bethstudio_host_socket` looks in
  `~/Library/Application Support/bethstudio` on macOS, the same folder
  the host binds. Without this the CLI bridge kept dialing
  `~/.local/share/wezterm/sock`.

## Revert

Restore the three `#[cfg(not(windows))]` stubs in `host.rs`
(`try_become_owner` returns `Ok(true)`, `id_running` checks the socket,
`request_stop_id` only unlinks the socket), put `session_dir` back on
`$XDG_CONFIG_HOME`, and return the Windows shell list from
`default_shells` on every platform.
