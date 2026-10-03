# Patch 0033 — Right-click on a non-active pane routes to the clicked pane

**Applied:** 2026-06-12
**Files:**
- `upstream-wezterm/wezterm-gui/src/termwindow/mouseevent.rs`
  (+~30 lines: a re-run of the pane-detection loop after
  `show_full_menu` is set, on `Release(Right)`, so the
  right-clicked pane flows through to the menu dispatch)
- `upstream-wezterm/PATCHES.md` (+1 row in the active-patches
  table)
- `upstream-wezterm/patches/0033-right-click-pane-fix.md`
  (this file)

**Status:** Active.

## What

When the user right-clicks on a **non-active** pane (a pane
in a tab that is not currently focused) and picks an entry
from the right-click menu — most commonly "open in new
tab" via the shell picker — the new tab inherits its
working directory (and any other per-pane metadata) from
the **active** tab, not from the right-clicked tab.

The fix is a 30-line addition to
`mouse_event_terminal` in
`wezterm-gui/src/termwindow/mouseevent.rs` that re-runs
the pane-detection loop on `Release(Right)` to update
`pane` to the right-clicked pane before
`show_full_menu` is called. The same `column` / `row`
from the original click event are used, so the
detection is identical to what happens on `Press`.

## Why

Rodrigo reported on 2026-06-12:

> "tem que ajustar onde abre o terminal, pois as vezes
> ele abre novo terminal em relacao ao terminal ativo
> ao inves de respeitar onde o usuario clicou com o
> menu"

The root cause is the interaction between patch 0010
(consume right-button down, show menu on button up)
and the pane-detection loop in `mouse_event_terminal`.
Patch 0010 returns early on
`WMEK::Press(MousePress::Right)` (mouseevent.rs:768),
so the `Press` arm of the pane-detection loop
(`mouseevent.rs:798-805`) is **never reached** for
right-clicks. The `Release(Right)` arm falls through
`WMEK::Release(_) | WMEK::HorzWheel(_) => {}`
(mouseevent.rs:817), so `pane` is also not updated on
release. The `pane` variable therefore stays as the
**active** pane (set at `mouse_event_impl`'s entry,
line 79: `let pane = self.get_active_pane_or_overlay()`),
and `show_full_menu` is called with the active pane's
id.

The menu dispatch then flows the active pane's id
through `TermWindowNotif::PerformAssignment { pane_id,
.. }`, which `perform_key_assignment` uses as the
`pane` for `SpawnCommandInNewTab` →
`spawn_command(spawn, SpawnWhere::NewTab)`. The
new tab inherits the cwd from the active pane
because `spawn_command_impl` (in
`wezterm-gui/src/spawn.rs:49-58`) reads
`current_pane_id = mux.get_active_tab_for_window(src_window_id)
.get_active_pane()` — always the active pane,
regardless of which pane the user right-clicked on.

## Why these decisions

- **Re-run the pane-detection loop** (instead of e.g.
  carrying the click coords through to the release
  handler) because the loop already has the right
  shape and we just need to do it on a different
  event kind. The detection logic is identical to
  the `Press` path, so the fix is a near-clone of
  the existing loop, gated on `show_full_menu`.
- **Use the original `position.column` /
  `position.row`** for the second pass (not the
  loop-mutated `column` / `row`) because the
  inner loop subtracts `pos.left` / `pos.top` for
  the within-pane coords; we need the
  viewport-relative coords for the hit test.
- **Do not call `tab.set_active_idx(pos.index)`** in
  the second pass. The user is **right-clicking**,
  not left-clicking — they may not want to focus
  the clicked pane (e.g. they want to spawn a new
  terminal in this pane's cwd without losing focus
  on the original pane). The
  `pane_focus_follows_mouse` config is the user's
  preferred way to express "I want focus to follow
  the mouse"; this patch does not override it.

## Revert

1. Revert the second pane-detection loop in
   `mouse_event_terminal` (the `if show_full_menu {
   ... }` block immediately after the existing
   pane-detection loop). The behaviour reverts to
   the pre-patch 0033 state (right-click on a
   non-active pane uses the active pane as the
   menu source).
2. Remove this file and the row for patch 0033
   from `PATCHES.md`.

## Risk

**Very low.** The added code is a 30-line
near-clone of the existing pane-detection loop,
gated on the `show_full_menu` boolean (only runs
on right-click release). No new API surface, no
new dispatch paths, no new shared state. If
`show_full_menu` is false, the new code is a
no-op. If `show_full_menu` is true, the new code
performs the same hit test the existing loop
does on `Press` — the only difference is the
`pane` variable is updated to the right-clicked
pane instead of left at the active pane.

Behavioural change is only visible to the user
when they right-click on a **non-active** pane
and then pick a menu entry that uses the pane's
id (most commonly `SpawnCommandInNewTab`). In
that case, the new tab now inherits cwd from
the right-clicked pane instead of the active
pane. This is exactly the user's reported
"respect where the user clicked with the menu"
behaviour.
