# 0176 — The bridge lists shells and starts terminals

**Status:** Implemented 2026-09-25.

## Why

The web UI's "Nova aba" should offer the same terminal types as the
GUI's "Novo terminal" menu and start one in the host.

## Protocol

```
{"op":"shells"}
  -> {"ev":"shells","shells":[{"id":"powershell","label":"PowerShell 5.1"}, ...]}
{"op":"spawn","shell_id":"powershell","window_id":3,"cwd":"C:\\work","request_id":"r1"}
  -> {"ev":"spawned","request_id":"r1","pane_id":32,"tab_id":25,"window_id":3}
  or {"ev":"error","message":"spawn powershell (request r1): ..."}
```

- The list is `wtinator::context_menu::default_shells()` (cmd,
  PowerShell 5.1/7, WSL default/Ubuntu, Git Bash, MobaXterm when
  present, plus user entries from `shells.json`, patch 0183), ids and
  labels only; the command line never
  comes from the client.
- `window_id` (a host window id) adds the terminal as a new tab of that
  window; without it the host creates a new window, which the attached
  GUI will also show.
- After a spawn the next `list` is sent immediately.

Verified read-only on the live host: `shells` returned the 8 ids above.
`spawn` was not exercised against the user's host (it would create a
real terminal there).

## Files

- `wezterm/src/cli/bridge.rs`

## Revert

Remove the `Shells`/`Spawn` requests and events and `spawn_shell`.
Remove row 0176 and this file.
