# 0202 — One process snapshot shared by all panes

**Status:** Implemented 2026-10-29.

## Why

On 2026-10-29 the user's host (30 panes, ~580 processes on the machine)
used 6–9 cores all the time. 97% of its CPU went to short-lived threads:
the per-pane refresh threads of patch 0200. Each one called
`LocalProcessInfo::with_root_pid`, which takes a Toolhelp32 snapshot of the
whole system before looking at the pane's own processes. Measured with
`procinfo` against the live panes: ~85 ms per call even for a pane with one
process, 3.6 s for the 30 panes. The bridge lists panes every 2 s, so each
pane paid for its own full snapshot every 2 s, and the 30 snapshots ran at
the same time.

## What

- `Snapshot::shared_entries` keeps the last snapshot for 1 s. Every
  `with_root_pid` within that window reuses it. The lock is held while a new
  one is taken, so callers that arrive together wait for one snapshot
  instead of taking 30.
- Same pane loop after the change: first pane 90 ms, the other 29 under
  2 ms each, 99 ms total.
- A process started less than 1 s ago may be missing from the tree until the
  next snapshot. The pane cache (patch 0200) was already up to 2 s stale.

## Files

- `procinfo/src/windows.rs` — `Snapshot::shared_entries`, used by
  `LocalProcessInfo::with_root_pid`

## Revert

Call `Snapshot::entries()` again in `with_root_pid`, remove
`shared_entries` and the `Arc`/`Mutex`/`Duration`/`Instant` imports. Remove
row 0202 and this file.
