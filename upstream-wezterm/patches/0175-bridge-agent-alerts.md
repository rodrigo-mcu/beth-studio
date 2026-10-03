# 0175 — The bridge forwards "agent waiting" alerts

**Status:** Implemented 2026-09-25.

## Why

The GUI marks a tab/window when an agent waits for the user (patch
0152: bell, OSC 9 toast, or a user var such as `claude_status=waiting`).
The web UI had no such signal: the host already pushes these alerts to
every client as unilateral `NotifyAlert` PDUs, but a client without a
local domain (the `bethterm cli bridge`) dropped them in
`process_unilateral` ("client doesn't have a real local domain").

## Fix

- `wezterm-client/src/client.rs`: `BETHTERM_UNILATERAL:
  OnceLock<fn(&Pdu)>`. When set, a domain-less client hands every
  unilateral PDU to it instead of dropping it.
- `wezterm/src/cli/bridge.rs`: installs the hook; `NotifyAlert`s go
  through a channel into the main loop and become
  `{"ev":"agent","pane_id":N,"waiting":B,"reason":"bell|toast|user_var","detail":"..."}`.
  - Bell / toast → waiting. A `*_status` / `*_waiting` / `claude_status`
    user var → waiting per `wtinator::agent_wait::user_var_is_waiting`
    (same rule as the GUI), otherwise not waiting.
  - `send`/`paste` to the pane clears it (`reason":"input"`), like
    focusing the pane in the GUI.
  - `{"op":"list"}` re-sends every pane still waiting.

State only covers alerts received while the bridge runs (the host has
no request for a pane's current user vars).

## Files

- `wezterm-client/src/client.rs`
- `wezterm/src/cli/bridge.rs`

## Revert

Remove the hook and its call, the alert channel and the `Agent` event.
Remove row 0175 and this file.
