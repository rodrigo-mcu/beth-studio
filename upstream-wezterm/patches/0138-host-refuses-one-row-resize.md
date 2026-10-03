# 0138 — Host refuses a resize that collapses a pane to one row

**Status:** Implemented 2026-09-21.

## What

`bethterm-host` (`wezterm-mux-server-impl/src/sessionhandler.rs`,
`Pdu::Resize`) now ignores a request for fewer than 2 rows when the
pane currently has 2 or more, and logs

```
bethterm-host: refusing resize of pane N to CxR (it has P rows); client-side layout bug?
```

Patch 0130 was exactly such a bug: a GUI-side ratchet shrank every
pane to 1 row one round trip at a time, and the only visible symptom
was "Enter jumps to the top". With this guard the shell keeps a usable
grid and the host log names the culprit on the first request.

A pane that legitimately starts tiny (host spawn at 1 row, then grows)
is unaffected: the guard only blocks a **shrink** below 2 rows.

## Revert

Delete the guard block. Remove row 0138 and this file.
