# 0177 — Echo latency meter in the bridge

**Status:** Implemented 2026-09-25.

## Why

Typing "stutters" in a Claude Code session. Patch 0170 measured the GUI
side: key -> host round trip 2 ms, paint gap ~17 ms, i.e. the GUI is
fast except when patch 0174's freeze hit. On 2026-09-25 the user typed
in the same kind of session through the web UI (no GUI in the path) and
it still stuttered. So the delay is after the GUI: host, ConPTY /
OpenConsole, or the program itself. Patch 0170's `rtt` cannot see that:
the host tags the next render delta with the key's serial whether or
not the program has echoed the key yet.

## What

`bethterm cli bridge` measures, per watched pane, the time from a `send`
to the next change of that pane's visible screen:

- while a key waits for its echo the bridge polls every 4 ms (30 ms
  otherwise), which also shortens the echo the web user sees;
- a key with no change after 3 s counts as 3000 ms;
- the slowest host screen RPC (`get_dimensions` + `get_lines`) of the
  period is recorded as `host_rpc_max`.

Every 30 s of typing, and when the bridge exits, one line per pane goes to
`%APPDATA%\bethterm\bridge-latency.log` (rotates at 1 MB):

```
2026-09-25 12:20:01.123 pid=1234 pane=10 keys=180 echo[p50=35 p95=240 max=900 >=100ms=40] host_rpc_max=6 title="✳ MOBI VMS"
```

Comparing a Claude pane with a plain PowerShell pane separates "the
program is slow to redraw" from "host/ConPTY is slow".

## Files

- `wezterm/src/cli/bridge.rs` — `EchoMeter`, faster poll while pending
- `wezterm/src/cli/list.rs` — `pane_id` and `title` visible to the bridge

## Revert

Remove `EchoMeter`, its calls and `POLL_ECHO`; restore the fixed `POLL`.
Remove row 0177 and this file.
