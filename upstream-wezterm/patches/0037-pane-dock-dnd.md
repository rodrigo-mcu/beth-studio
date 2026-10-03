# Patch 0037 — VS-style pane docking drag-and-drop (+ session/close/border refinements)

**Applied:** 2026-06-13
**Status:** Active.

## What

Drag a terminal by its header bar and dock it like Visual
Studio's window docking:

- While dragging, a small blue **"puck"** with grip dots follows
  the cursor so the drag is visible from the start.
- Hovering a **tab** in the strip **spring-loads** (switches to)
  that tab so you can position the pane inside it.
- Hovering another **pane** shows a translucent blue **drop-zone
  overlay** on the half where the pane will land; the zone is
  picked from the cursor position within the target pane
  (Left / Right / Up / Down edges, or Center).
- Releasing **docks** the dragged pane: Left/Right → horizontal
  split, Up/Down → vertical split, Center → swap. Works within a
  tab (reposition) and across tabs. Releasing on a tab (not a
  pane) moves the pane into that tab.

## Key pieces

- `wtinator::groups::dock_pane_to_pane(dragged, target, DockZone)`
  + `DockZone { Left, Right, Up, Down, Center }` — removes the
  pane from its source tab and `split_and_insert`s it at the
  target pane's index in the requested direction (Center =
  `swap_active_with_index`); removes the source tab if it empties.
- `TermWindow::pane_dock_hover: Option<PaneDockHover>` — live
  drag target/zone, set in `mouseevent::drag_ui_item`
  (`update_pane_dock_hover` hit-tests panes by cell), consumed in
  `complete_drag_drop`, cleared on mouse-leave.
- Render: `render/pane.rs` draws the drop-zone overlay on the
  target pane; `render/paint.rs::paint_pane_drag_indicator` draws
  the cursor puck.
- Spring-load: `drag_ui_item` resolves the UI item under the
  cursor; if it is a tab, `activate_tab`s it.

## Related refinements that landed alongside (same session)

- **0029.1 / 0029.2 — session restore fidelity**: restored tabs
  now get their `user_title` (patch 0031) back, each pane gets
  its **own** `header_text` (matched by order, not applied to all
  panes), and the split-direction heuristic was un-inverted
  (`top > 0` ⇒ vertical, else horizontal — restored layouts were
  coming back rotated 90°). Simple/linear splits now restore with
  correct orientation; complex trees are still approximate
  (saving the exact split tree via `codec_pane_tree` is a future
  patch).
- **0032.1 — native pane close**: right-click "Close pane" now
  uses the Win32 `MessageBox` (`wtinator::confirm`) instead of the
  Skia overlay.
- **0032.2 — native window close**: the window-close confirmation
  ("Really kill this window…") is now the Win32 `MessageBox` too.
- **0036.2…0036.11 — focus border**: the active-pane focus
  outline was iterated to a crisp blue line on the terminal's
  content frontier (half-cell outset, clamped to the window;
  bottom includes the header row). Fine pixel placement is still
  open (deferred by the user).

## Revert

- `dock_pane_to_pane` + `DockZone` in `wtinator/src/groups.rs`.
- `PaneDockHover` + `pane_dock_hover` field in
  `wezterm-gui/src/termwindow/mod.rs`.
- `update_pane_dock_hover`, the `PaneHeader` arm in
  `drag_ui_item`, the dock branch in `complete_drag_drop`, and the
  mouse-leave clear in `mouseevent.rs`.
- The dock overlay block in `render/pane.rs` and
  `paint_pane_drag_indicator` in `render/paint.rs`.

## Risk

**Medium.** Additive feature; the dock op reuses the
`move_pane_to_group` pattern (`remove_pane` + `split_and_insert`)
which is well-exercised. The render overlays are pure overlays
(no layout shift). The session-restore direction fix changes
behaviour for everyone but is strictly more correct.

## Verification

- `cargo +nightly test -p wtinator` (109 pass — incl.
  `dock_zone_variants_and_same_pane_is_noop`).
- `cargo +nightly build --release -p wezterm-gui` — clean.
- Manual (confirmed by user 2026-06-13): drag a terminal onto
  another → dock zones appear and dock works; drag onto a tab →
  switches tab; tabs/terminals/positions/names save and restore.
