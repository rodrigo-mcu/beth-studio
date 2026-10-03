# Patch 0035 — Drag-and-drop: reorder tabs + move a pane to another tab

**Applied:** 2026-06-13
**Files:**
- `upstream-wezterm/wtinator/src/groups.rs`
  (+~70 lines: new `move_pane_to_tab(pane_id, target_tab_id)`
  sibling of `move_pane_to_group`; unzooms the target tab,
  splits the dragged pane into the target's active pane, and
  removes the source tab if it becomes empty)
- `upstream-wezterm/wezterm-gui/src/termwindow/mod.rs`
  (+~40 lines: new `TermWindow::move_tab_from_to(from, to)`
  that generalizes the keyboard-only `move_tab` at
  `mod.rs:2564`; a new `complete_drag_drop` method that
  hit-tests the release position and dispatches either a
  tab reorder or a pane move; the `dragging` field gains the
  armed drag-source kind)
- `upstream-wezterm/wezterm-gui/src/termwindow/mouseevent.rs`
  (+~60 lines: arm the drag on left-press of a `Tab` /
  `PaneHeader` UI item, complete it on left-release via
  `complete_drag_drop`; release handler is gated on the
  armed item type and falls through for `Split` /
  `ScrollThumb`)
- `upstream-wezterm/wezterm-gui/src/termwindow/render/pane.rs`
  (+~10 lines: the always-visible pane header bar from patch
  0030.5 now registers a `UIItemType::PaneHeader(PaneId)` UI
  item so the header is hit-testable as a drag source)
- `upstream-wezterm/PATCHES.md` (+1 applied row; planned rows
  renumbered 0034.5/0035/0036 → 0036/0037/0038)
- `upstream-wezterm/patches/0035-drag-and-drop.md` (this file)

**Status:** Active.

## What

Two mouse drag-and-drop interactions in the custom title/tab
strip:

1. **Reorder a tab** — press-and-hold the left button on a
   tab in the tab strip, drag it left or right, and release
   over the target slot. The tab is moved to the drop slot's
   index. There is no live insertion marker; the reorder
   happens on drop.
2. **Move a pane to another tab** — press-and-hold the left
   button on a pane's always-visible header bar (the header
   from patch 0030.5), drag it up onto a tab in the tab
   strip, and release. The dragged pane is split into the
   target tab's active pane, and the source tab is removed
   if it becomes empty.

Dropping off-target (releasing the drag anywhere that is not a
valid drop target) is a no-op. Double-clicking the pane header
still opens the rename dialog (patch 0030.5) — the single-press
arms the drag, but a release without movement / a double-click
is not treated as a drop.

## Why

Rodrigo asked on 2026-06-13:

> "permitir mover a tab (a posicao dela)"

and

> "permitir mover o terminal para outra tab ou outra posicao
> ... se tiver como fazer um arrastar e soltar ficaria lindo
> e facil de usar"

The existing "Move pane to…" submenu (patch 0028) already lets
a pane be moved into a new tab in another *group*, but there
was no way to (a) reorder tabs with the mouse, or (b) move a
pane into an *existing* tab. The user explicitly asked for a
drag-and-drop gesture because it is the most discoverable and
direct way to express both operations.

## How the two drags work

Both drags share the same lifecycle: **arm on press, complete
on release.**

1. **Arm on press.** On `WMEK::Press(MousePress::Left)`, the
   mouse handler resolves the UI item under the cursor
   (`resolve_ui_item`). If it is a `Tab` or a
   `PaneHeader(PaneId)`, the handler stashes the drag source
   (the tab index, or the pane id) in `self.dragging`. Other
   item types (`Split`, `ScrollThumb`, …) keep their existing
   press behaviour — the drag is not armed for them.
2. **Complete on release.** On
   `WMEK::Release(MousePress::Left)`, if `self.dragging` is
   armed, `complete_drag_drop` is called. It hit-tests the
   release position against the current UI items:
   - If the drag source was a **tab** and the release lands
     on another tab, `move_tab_from_to(from_index, to_index)`
     reorders the tabs.
   - If the drag source was a **pane header** and the release
     lands on a tab, `wtinator::groups::move_pane_to_tab(
     pane_id, target_tab_id)` moves the pane into that tab.
   - Otherwise (release off-target, or release on the same
     tab), the drag is dropped silently.
   `self.dragging` is cleared in all cases.

The release handler is **gated on the armed drag-source item
type**: if the press did not arm a `Tab` / `PaneHeader` drag
(e.g. it armed a `Split` drag-to-resize or a `ScrollThumb`
drag), `complete_drag_drop` returns early and the existing
release behaviour runs unchanged.

## Reuse from existing code

- **`wtinator::groups::move_pane_to_group`** (patch 0028,
  `groups.rs:155`): the new `move_pane_to_tab` is a sibling
  built on the same pattern — resolve the source pane / tab
  from the mux, perform the move, remove the source tab if it
  becomes empty. The difference is the destination: a *split
  into an existing tab's active pane* instead of a *new tab
  in a target group*.
- **`Tab::split_and_insert`**: the upstream split primitive
  used by `move_pane_to_tab` to graft the dragged pane into
  the target tab. Reusing it means the destination tab's
  existing split layout is preserved.
- **`TermWindow::move_tab`** (`mod.rs:2564`): the existing
  keyboard-only tab-reorder action. The new
  `move_tab_from_to(from, to)` generalizes it (the keyboard
  path moves the *active* tab by ±1; the drag path moves an
  *arbitrary* tab to an *arbitrary* slot). The keyboard
  `move_tab` is refactored to call `move_tab_from_to`.
- **`self.dragging` field + `drag_ui_item`**: the upstream
  drag-state plumbing already used for split-resize and the
  scrollbar thumb. The patch adds the `Tab` / `PaneHeader`
  drag-source kinds to the same field instead of inventing a
  parallel state machine.
- **`resolve_ui_item`**: the upstream hit-test that maps a
  mouse position to a `UIItem`. Used both to arm the drag (on
  press) and to find the drop target (on release).

## Why these decisions

- **`UIItemType::PaneHeader` gains a `PaneId` payload** so the
  release-time hit test knows *which* pane was dragged without
  re-deriving it from the active tab. This is a small enum
  change touched at ~6 sites (the enum definition, the
  pane-header render that constructs it, and the match arms
  that destructure `UIItemType`).
- **Reorder on drop, no live insertion marker.** A live marker
  (the gap that opens between tabs as you drag) is nice polish
  but needs per-frame render state and a re-layout of the tab
  strip on every mouse-move. The user asked for the gesture to
  "ficar lindo e facil de usar"; a reorder-on-drop is the
  functional MVP and the marker is deferred (see Out of scope).
- **Unzoom the target tab before the pane move.** If the
  target tab is zoomed, `split_and_insert` into its active
  pane would graft the dragged pane into a hidden layout. The
  move unzooms first so the result is visible immediately.
- **Dropping the last pane removes the source tab.** Mirrors
  patch 0028's `move_pane_to_group` behaviour — a tab with no
  panes left is closed.
- **Double-click still renames.** The press arms the drag, but
  a release-in-place (no movement onto a different target) is a
  no-op, so the patch 0030.5 double-click-to-rename gesture is
  unaffected.

## Revert

1. In `wtinator/src/groups.rs`, remove `move_pane_to_tab` and
   its tests.
2. In `wezterm-gui/src/termwindow/mod.rs`, remove
   `complete_drag_drop` and `move_tab_from_to`, and revert
   `move_tab` to its original body. Remove the `Tab` /
   `PaneHeader` drag-source kinds from `self.dragging`.
3. In `wezterm-gui/src/termwindow/mouseevent.rs`, remove the
   press-arm and release-complete arms for the `Tab` /
   `PaneHeader` drags.
4. In `wezterm-gui/src/termwindow/render/pane.rs`, drop the
   `UIItemType::PaneHeader(PaneId)` UI-item registration on
   the header bar.
5. Revert the `PaneId` payload on `UIItemType::PaneHeader`
   back to its prior shape and fix up the ~6 match sites.
6. Remove this file and the row for patch 0035 from
   `PATCHES.md`; restore the planned rows to their previous
   numbers (0036/0037/0038 → 0034.5/0035/0036).

## Risk

**Medium.** Larger surface than the recent bug-fix patches:

- The `UIItemType::PaneHeader` enum change touches ~6 sites; a
  missed match arm is a compile error (caught at build time),
  not a silent runtime bug.
- The release handler **intercepts** the left-button release.
  It is gated on the armed drag-source item type and **falls
  through for `Split` / `ScrollThumb`**, so split-resize and
  scrollbar-thumb drags keep working. A regression here would
  show up as a broken split-resize or scrollbar.
- A **pane move while the target tab is zoomed** is handled by
  unzooming the target first; without that, the move would
  graft into a hidden layout.
- **Dropping the last pane** of a source tab removes that tab
  (same as patch 0028).

If the press did not arm a `Tab` / `PaneHeader` drag, the new
release code is a no-op and all existing mouse behaviour is
unchanged.

## Out of scope (deferred)

- **Live insertion marker** — the visual gap that opens
  between tabs while dragging. Reorder happens on drop only.
- **Drop-target highlight** — no highlight of the tab the
  cursor is currently over during a drag.
- **Tear-off to a new window** — dragging a tab / pane out of
  the strip to spawn a new window is not implemented.
- **Reorder panes within a tab** — this patch moves a pane
  *between tabs*; reordering / re-splitting panes inside the
  same tab by drag is not implemented.
