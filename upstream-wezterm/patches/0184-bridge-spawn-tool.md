# 0184 — The bridge starts SSH and serial sessions as terminals

**Status:** Implemented 2026-09-25.

## Why

The web UI (`bethterm-web`) gained saved SSH hosts and serial-port
profiles. A session must live in the host like any terminal, so it
survives web/GUI restarts and also shows in the GUI. The session itself
runs in a small console program shipped next to `bethterm.exe`:
`bethterm-tool.exe --ssh <id>` / `bethterm-tool.exe --serial <id>`
(a GUI-subsystem exe gets no console when created in a ConPTY, hence a
separate console-subsystem exe).

The bridge's `spawn` (patch 0176) only starts entries of the shell list,
never a command chosen by the client. This op keeps that rule: the
client picks a kind and a profile id; the command line is built here.

## Protocol

```
{"op":"spawn_tool","kind":"ssh","id":"0123456789abcdef","window_id":3,"request_id":"r1"}
  -> {"ev":"spawned","request_id":"r1","pane_id":41,"tab_id":30,"window_id":3}
  or {"ev":"error","message":"spawn_tool ssh (request r1): ..."}
```

- `kind` maps through a fixed table: `ssh` -> `--ssh`, `serial` ->
  `--serial`; anything else is refused.
- `id` must be exactly 16 lowercase hex digits (the profile id the web
  UI generates); anything else is refused.
- Command: `<folder of bethterm.exe>\bethterm-tool.exe <flag> <id>`, no
  cwd. If the tool is missing the error says so.
- `window_id` behaves as in `spawn`: new tab of that host window, or a
  new window without it. The next `list` is sent right away.

## Files

- `wezterm/src/cli/bridge.rs` — `Request::SpawnTool`, `tool_flag`,
  `valid_tool_id`, `spawn_tool`, test `only_known_kinds_and_hex_ids`

## Revert

Remove the request, its handler, the helpers and the test. Remove row
0184 and this file.
