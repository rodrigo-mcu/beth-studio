# Patch 0014 — `KeyAssignment::SelectAll` + native menu entry

**Applied:** 2026-06-06
**Files:**
- `upstream-wezterm/config/src/keyassignment.rs`
- `upstream-wezterm/wezterm-gui/src/termwindow/mod.rs`
- `upstream-wezterm/wezterm-gui/src/commands.rs`
- `upstream-wezterm/wtinator/src/context_menu.rs`

**Status:** Active

## What

Three coordinated changes:

1. **Upstream `KeyAssignment::SelectAll`** — a new enum variant in
   `config/src/keyassignment.rs`, sitting next to the existing
   `ClearSelection` and `CompleteSelection` variants.

2. **Upstream dispatch in `wezterm-gui`** — the `perform_key_assignment`
   arm computes a `SelectionRange` that covers every row of the
   active pane, from `scrollback_top` to the last visible row. The
   selection is set on `self.selection(pane_id).range` and rendered
   normally. The `commands.rs` table is updated so the new variant
   appears in the command palette with the `CTRL|SHIFT+A` shortcut
   and the `Edit` menu hint.

3. **Native menu entry** — `wtinator::context_menu` gets a new
   `NativeCommand::SelectAll` (wID `0x4003`) that maps to the
   upstream `KeyAssignment::SelectAll`. It is the third item of the
   clipboard group in the full menu (after `Copy selection` and
   `Paste`).

## Why a new upstream variant

Patch 0013 had a TODO that said "Select all is missing because
there is no `KeyAssignment::SelectAll` in the upstream enum". The
two ways to fix that were:

1. Add a Lua keybinding `CTRL|SHIFT+A = SelectTextAtMouseCursor(Line)` —
   this would require a `ScrollToTop` first, which is a multi-step
   sequence. Also, the user's mouse cursor is not necessarily on
   the pane; the selection would be tied to a fake coordinate.
2. Add a new upstream `KeyAssignment::SelectAll` variant.

We chose option 2. The patch is small (one enum variant, one match
arm in `perform_key_assignment`, one arm in `commands.rs`, one
upstream `use` line) and it is a real primitive that users want
across the entire app — not just from the right-click menu.

The implementation in `wezterm-gui/src/termwindow/mod.rs` uses the
`Selection` already present on every `PaneState`:

```rust
SelectAll => {
    let dims = pane.get_dimensions();
    let last_row = dims.physical_top
        + (dims.viewport_rows as isize).saturating_sub(1);
    let mut sel = self.selection(pane.pane_id());
    sel.range = Some(SelectionRange {
        start: SelectionCoordinate {
            x: SelectionX::Cell(0),
            y: dims.scrollback_top,
        },
        end: SelectionCoordinate {
            x: SelectionX::Cell(usize::MAX),
            y: last_row,
        },
    });
    sel.origin = None;
    sel.rectangular = false;
}
```

This is *the* natural way to express "everything is selected" in
the existing selection model — the upstream `SelectionRange` already
exposes the start / end coordinates used here. The range is
inclusively drawn over the rows, which matches what a user expects
from `Ctrl+Shift+A` in any text editor.

## What the user sees

In the right-click context menu (full menu), the clipboard group
now reads:

```
Copy selection
Paste
Select all
```

Clicking `Select all` causes the entire scrollback and the visible
viewport of the focused pane to render with the selection
highlight. The selection is then ready to be copied with
`Copy selection` (or `Ctrl+Shift+C`).

## Revert

To remove the `Select all` entry from the native menu but keep the
upstream `KeyAssignment::SelectAll` (in case other code paths use
it):

1. In `wtinator/src/context_menu.rs`:
    - Drop the `SelectAll` variant from `NativeCommand`.
    - Drop the `0x4003` arm in `w_id()`, `dispatch_native`, and
      `classify`.
    - Drop the `MenuEntry::Item` push in `full_menu_items()`.
2. Drop the 2 new tests
   (`dispatch_native_select_all_returns_select_all`,
    `classify_routes_known_assignments` covers the other 0x400X
    IDs).

To remove the upstream variant entirely:

3. In `config/src/keyassignment.rs`, drop the `SelectAll` variant
   line.
4. In `wezterm-gui/src/termwindow/mod.rs`, drop the `SelectAll`
   arm in `perform_key_assignment` and the `SelectionCoordinate` /
   `SelectionX` import that becomes unused.
5. In `wezterm-gui/src/commands.rs`, drop the `SelectAll` arm in
   `derive_command_from_key_assignment`.
6. Remove this file and the row for patch 0014 from `PATCHES.md`.

## Risk

Low. The new variant is additive — it does not change any existing
match arm. The only "new" piece of GUI logic is the
`SelectionRange` write, which goes through the same `RefCell` and
render path that `select_text_at_mouse_cursor` already uses.

19/19 unit tests pass (`cargo +nightly test -p wtinator`).
`wezterm.exe` and `wezterm-gui.exe` build in debug and release
with no new warnings.
