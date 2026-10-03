# 0180 — Bridge can close a terminal, only on explicit confirmation

**Status:** Implemented 2026-09-25.

## Why

The user's rule: closing a web tab or view must never end a terminal —
only `exit` in the shell, or an explicit "Encerrar terminal…" with a
confirmation dialog, may do that. The bridge needed a way to carry out
that explicit action.

## Protocol

```
{"op":"kill","pane_id":33}
```

Sends `KillPane` to the host for that pane. No response event of its
own: the pane disappears from the next `list`, and any watcher gets
`pane_gone` (patch 0179).

The web UI is the only caller, and only from its confirmed "Encerrar
terminal…" action (right-click menu); every other UI action that
removes a terminal from view (closing a tab, closing a view, dragging
out of the organization, closing the app window) never sends `kill`.

## Files

- `wezterm/src/cli/bridge.rs`

## Revert

Remove the `Kill` request and its handling. Remove row 0180 and this
file.
