# 0174 — Changed-line scans start at the scrollback top

**Status:** Implemented 2026-09-25.

## Symptom

2026-09-25 11:11:55 the GUI stopped answering for **241 s** (ui
watchdog, patch 0162). The watchdog dump
(`%LOCALAPPDATA%\bethterm\hang-dumps\bethterm-gui-63476-1790345525.dmp`)
has the main thread in:

```
rangeset::RangeSet::add_range
wezterm_client::pane::renderable::RenderableState::get_changed_since
wezterm_client::pane::clientpane::ClientPane::get_changed_since
wezterm_mux_server_impl::sessionhandler::PerPane::compute_changes (per_pane)
wezterm_mux_server_impl::sessionhandler::maybe_push_pane_changes
... SessionHandler::schedule_pane_push
window::spawn::SpawnQueue::run
```

The GUI runs its own mux server (gui-sock). With any client connected
to it, every `PaneOutput` schedules a push for that client.

## Cause

`compute_changes` called `get_changed_since(0..physical_top + rows)`.
`physical_top` is a stable row index: it counts every line the pane has
printed since it started, not the scrollback size. For a pane that ran
an agent for hours it is in the millions. The host's own terminal panes
answer that cheaply, but `ClientPane` (the GUI's proxy of a host pane)
walks the range row by row, and every uncached row goes into the
`RangeSet`.

## Fix

- `sessionhandler.rs`: the scan starts at `dims.scrollback_top`.
- `renderable.rs`: `get_changed_since` clamps the start to its
  `scrollback_top` as well, so any other caller passing `0..` is safe.

Rows above the scrollback top no longer exist, so nothing is lost.

The GUI gets both halves with the new `bethterm-gui.exe`. The host gets
the `sessionhandler.rs` half only when `bethterm-host.exe` is rebuilt
and restarted (not done while the user's terminals live in it).

## Files

- `wezterm-client/src/pane/renderable.rs`
- `wezterm-mux-server-impl/src/sessionhandler.rs`

## Revert

Restore `0..` in `compute_changes` and drop the clamp in
`get_changed_since`. Remove row 0174 and this file.
