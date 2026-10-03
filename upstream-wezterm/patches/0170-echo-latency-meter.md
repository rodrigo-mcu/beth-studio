# 0170 — Measure typing latency in the running GUI

**Status:** Implemented 2026-09-25.

## Why

Typing in a Claude session inside BethTerm "stutters"; the same work in
Windows Terminal feels fluid. Sampling from outside (2026-09-25) showed
the GUI UI thread never blocked (worst 14 ms) while GUI CPU rose to
30–63 % of a core and host CPU to 10–25 % during typing. That rules out
a frozen UI but cannot tell where the echo delay is: the GUI -> host ->
PTY -> host -> GUI round trip, or the paint after the echo arrives.

A separate GUI+host test pair is not safe on the user's session: the
single host uses session-global names (`Local\BethTermHost`,
`Local\BethTermHostQuit`) that `APPDATA` does not isolate. So the meter
ships in the GUI and measures real use; it installs with `gui-restart`
and does not touch the host.

## What it measures

- `rtt`: `InputSerial` of the key -> the render delta the host sends
  back with it (upstream already computed `last_input_rtt` for
  predictive echo; the new `BETHTERM_ECHO_RTT` hook exposes it).
- `paint_gap`: that delta arriving -> end of the next painted frame.
- `frame`: `paint_impl` time of those frames.

`rtt + paint_gap` is the echo delay the user sees.

## Output

`%APPDATA%\bethterm\echo-latency.log`, one line per minute with typing:

```
2026-09-25 11:02:03.120 pid=1234 keys=180 rtt[p50=8 p95=31 max=140 >=100ms=2] paint_gap[...] frame[...]
```

Rotates at 1 MB (one `.1.log` kept). Nothing is written while idle.

## Files

- `wezterm-client/src/pane/clientpane.rs` — `BETHTERM_ECHO_RTT` hook
- `wezterm-client/src/pane/mod.rs` — re-export
- `wezterm-client/src/pane/renderable.rs` — call the hook with the rtt
- `wezterm-gui/src/main.rs` — `wtinator::echo_latency::install()`
- `wezterm-gui/src/termwindow/render/paint.rs` — `record_frame`
- `wtinator/src/echo_latency.rs` (new), `wtinator/src/lib.rs`,
  `wtinator/src/host.rs` (`life_stamp` is `pub(crate)`)

## Revert

Remove the hook, its call and re-export, the two GUI calls and
`echo_latency.rs`. Remove row 0170 and this file.
