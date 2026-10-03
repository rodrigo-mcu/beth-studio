# 0130 — Host sync shrank every pane to 1 row

**Status:** Implemented 2026-09-21.

## Symptom

Since the GUI/host split (patch 0121): Enter "refreshes" the pane and the
view lands at the top of the scrollback; a full-screen agent (Claude,
Codex, Grok) redraws in a loop and cannot be used.

`bethterm cli list` against `%APPDATA%\bethterm\host.sock` showed the
cause directly: the host pane was **158x1** (pixel height 22, one cell).
The shell and every TUI were running in a one-row terminal. The GUI
window itself was created 1600x72 px at attach because it follows the
host tab size.

## Cause

A one-row-per-round-trip ratchet between GUI and host:

1. The host reports pane sizes as **content** sizes (its panes carry no
   header row).
2. `TabInner::sync_with_pane_tree` (runs on attach and on every
   `TabResized` from the host) stored that content size as the local
   tab size and called `resize(size)`.
3. `resize` applies patch 0067: every leaf reserves one row for the pane
   header, so the local `ClientPane` was resized to `rows - 1`.
4. `ClientPane::resize` sends that smaller size to the host; the host
   resizes the PTY and broadcasts `TabResized`.
5. Back to 2. The debug log shows ~40 `TabResized` in 20 ms, and the
   pane ends at `rows == 1` (the reservation stops at one row).

With a `LocalPane` there is no round trip, so patches 0067/0087 never
showed this. Patches 0127 and 0129 were written today against the same
symptoms; they were not the cause. 0129 is reverted in the same commit:
its output-time viewport reset made reading the scrollback impossible
while a process prints.

## Fix (`mux/src/tab.rs`)

- `sync_with_pane_tree` converts the host content size to the layout
  size (`add_header_rows`, one base row per stacked header via
  `header_rows_for_tree`) and re-lays the split tree with
  `resize_impl(size, false)`: node sizes are updated, leaves are **not**
  resized. The panes already have exactly the size the host reported,
  so no `Resize` PDU goes back and the loop ends.
- `resize` is now `resize_impl(size, true)`; behaviour for local panes
  is unchanged.
- Regression test `sync_with_host_sizes_does_not_shrink_panes`: two
  syncs with a 44-row host pane leave the pane at 44 rows and the tab
  at 45 (content + header); a follow-up `tab.resize` is a no-op.

## Verification

- `cargo +nightly test -p mux --lib tab::test` — 6 passed.
- After the fix, attach a GUI and run `bethterm cli --no-auto-start list`
  with `WEZTERM_UNIX_SOCKET=%APPDATA%\bethterm\host.sock`: the pane must
  report the window's content rows (for example 190x44), not `x1`.

## Revert

Restore `self.resize(size)` in `sync_with_pane_tree`, drop
`resize_impl`/`header_rows_for_tree`/`add_header_rows` and the test.
Remove this document and row 0130 from `PATCHES.md`.
