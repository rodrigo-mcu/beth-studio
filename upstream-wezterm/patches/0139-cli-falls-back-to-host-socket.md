# 0139 — `bethterm cli` talks to the host by default

**Status:** Implemented 2026-09-21.

## Symptom

`bethterm cli list` failed with `failed to connect to
Socket("gui-sock-<pid>")`. The GUI does not publish a gui-sock in
BethTerm mode, and since patch 0121 the panes live in
`bethterm-host.exe` anyway. The only way to use the CLI was to set
`WEZTERM_UNIX_SOCKET=%APPDATA%\bethterm\host.sock` by hand.

## Fix (`wezterm-client/src/client.rs`)

`Client::compute_unix_domain` keeps the upstream order
(`WEZTERM_UNIX_SOCKET`, then a discovered gui-sock) and, before
falling back to `unix_domains` from the config, uses
`%APPDATA%\bethterm\host.sock` (Windows) or
`~/.config/bethterm/host.sock` when that file exists. The path mirrors
`wtinator::host::socket_path`; this crate cannot depend on `wtinator`.

## Verification

With the host running: `bethterm.exe cli --no-auto-start list` prints
the host panes with no environment variable set.

## Revert

Remove `bethterm_host_socket` and its call. Remove row 0139 and this
file.
