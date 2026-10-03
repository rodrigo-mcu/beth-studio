# 0171 — `bethterm cli bridge`: JSON-lines access to the host for the web UI

**Status:** Implemented 2026-09-25.

## Why

`bethterm-web` (Go + React, in the workspace root) shows the host's
terminals in an embedded browser. Speaking the mux wire protocol
(leb128 frames, bincode, zstd) from Go would mean re-implementing the
codec. Instead the CLI grows a long-lived subcommand that already has a
`wezterm_client::Client` and translates to JSON lines.

It is a plain mux client, like `cli list`: it never starts, stops or
signals the host. It always connects to the host socket (`--prefer-mux`
is implied), not to the running GUI: the first version went through the
GUI and lost its connection when the GUI restarted at 11:01 on
2026-09-25, then kept printing `list: ChannelSendError` forever. Pane
ids are therefore host ids. When the host connection is lost the bridge
now exits non-zero so the front end respawns it.

### Inherited GUI socket (2026-09-25, second fix)

Started from the tray, `bethterm-web` and its bridge inherited the
GUI's `WEZTERM_UNIX_SOCKET=...\gui-sock-<gui pid>`, and in
`Client::compute_unix_domain` that variable won over `prefer_mux`. After
a `gui-restart` the bridge chased a dead GUI socket, tried to spawn
`wezterm-mux-server.exe --daemonize` (not shipped) and exited, every
15 s. Now:

- `compute_unix_domain` ignores a `WEZTERM_UNIX_SOCKET` that names a
  `gui-sock-*` file when `prefer_mux` is set (the host wins);
- the bridge implies `--no-auto-start`: it never spawns a mux server;
- the tray (patch 0173) starts `bethterm-web` without
  `WEZTERM_UNIX_SOCKET` / `WEZTERM_PANE`.

Verified: bridge started with `WEZTERM_UNIX_SOCKET` pointing at a dead
`gui-sock-63476` lists the host's 17 panes, empty stderr.

## Protocol

One JSON object per line.

Requests (stdin):

```
{"op":"list"}
{"op":"watch","pane_id":9}            // replaces the watched set
{"op":"watch","pane_ids":[9,10]}
{"op":"send","pane_id":9,"data":"ls\r"}   // raw bytes (WriteToPane)
{"op":"paste","pane_id":9,"data":"..."}   // SendPaste (bracketed)
{"op":"scroll","pane_id":9,"offset":20}   // view 20 lines above the live screen
```

Events (stdout):

```
{"ev":"list","panes":[ ...same items as `cli list --format json`... ]}
{"ev":"screen","pane_id":9,"cols":96,"rows":27,"cursor_x":0,"cursor_y":26,
 "cursor_visible":true,"text":"<SGR escapes, rows joined by CRLF, no trailing CRLF>"}
{"ev":"error","message":"..."}
```

- `list` is re-sent when it changes (checked every 2 s) and on request.
- Watched panes are polled every 30 ms; a `screen` event is sent only
  when the text or cursor changed.
- `scroll` sets how many lines above the live screen a pane shows (0 =
  live; clamped to the scrollback). `send`/`paste` jump back to 0. The
  `screen` event carries `"offset"` (shown) and `"scrollback"` (lines
  above the live screen); scrolled back, `cursor_visible` is false.
  Verified on the live host: pane 31 with 1094 lines of scrollback,
  offset 20 and a clamped 999999 -> 1094.
- Closing stdin ends the process.

Measured on the live host (17 panes): first `list` 14 ms, first
`screen` 18 ms after start.

## Files

- `wezterm/src/cli/bridge.rs` (new)
- `wezterm/src/cli/list.rs` — pane collection moved to `collect_items`
- `wezterm/src/cli/mod.rs` — `bridge` subcommand, implied `--prefer-mux` and `--no-auto-start`
- `wezterm-client/src/client.rs` — `compute_unix_domain` ignores an inherited gui-sock with `prefer_mux`

## Revert

Delete `bridge.rs`, its `mod` line and enum/dispatch arms; inline
`collect_items` back into `ListCommand::run`. Remove row 0171 and this
file.
