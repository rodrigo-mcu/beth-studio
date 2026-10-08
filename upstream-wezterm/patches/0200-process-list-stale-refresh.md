# 0200 — Process list refresh off the host main thread

**Status:** Implemented 2026-10-07.

## Why

Typing in Beth Studio stuttered in ~1.1 s spikes while CPU was idle.
`bridge-latency.log` (patch 0177) showed healthy medians (8-12 ms) and
repeated `max≈1100`. `bethterm cli list` against the 30-pane host took
1.1-2.6 s, while `cli list-clients` (also a main-thread request) took 29 ms.

`ListPanes` runs on the host main thread and, per pane, calls
`get_title` / `get_current_working_dir` with `CachePolicy::AllowStale`.
`LocalPane::divine_process_list` only looked at the 300 ms TTL, so a
stale entry was refreshed synchronously: `LocalProcessInfo::with_root_pid`
takes a full Toolhelp snapshot and reads the PEB of every process in the
pane's tree. 30 panes x that, every 2 s from the bridge plus the GUI.

## What

With `AllowStale` and an existing (stale) entry, return it immediately and
refresh on a background thread (one at a time per pane, `proc_refreshing`).
`FetchImmediate` and the first fill stay synchronous. The tree walk moved
to `build_cached_proc_info`.

## Files

- `mux/src/localpane.rs`

## Revert

Restore the synchronous refresh in `divine_process_list`; drop
`proc_refreshing` and make `proc_list` a plain `Mutex` again.
Remove row 0200 and this file.
