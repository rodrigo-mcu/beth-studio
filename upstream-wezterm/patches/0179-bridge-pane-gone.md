# 0179 — A closed pane is not a bridge error

**Status:** Implemented 2026-09-25.

## Symptom

The user closed a terminal that the web UI was watching. The host then
answered `no such pane 32` to the bridge's `get_lines`/`get_dimensions`
calls, and the bridge reported it as an ordinary error:

```
screen of pane 32: unexpected response Ok(ErrorResponse { reason: "Error: no such pane 32" })
```

The web UI showed this as a warning banner. A closed terminal is not a
failure of the bridge or the host.

## Fix

`bethterm cli bridge` recognizes `"no such pane"` in the error text of a
watched pane's screen fetch, drops that pane from the watched set, and
emits `{"ev":"pane_gone","pane_id":N}` instead of an error. It also
refreshes the pane list right away so the front end's list agrees.

## Files

- `wezterm/src/cli/bridge.rs`

## Revert

Remove the `"no such pane"` branch and `Event::PaneGone`; treat every
screen-fetch error the same as before. Remove row 0179 and this file.
