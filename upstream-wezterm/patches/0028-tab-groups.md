# Patch 0028 — Tab groups + "Move pane to…"

**Applied:** 2026-06-07
**Files:**
- `upstream-wezterm/mux/src/tab.rs` (modified, +40 lines)
- `upstream-wezterm/wtinator/src/groups.rs` (new, +250 lines)
- `upstream-wezterm/wtinator/src/lib.rs` (already had `pub mod groups;`)
- `upstream-wezterm/wtinator/src/context_menu.rs` (+140 lines)
- `upstream-wezterm/wezterm-gui/src/termwindow/mouseevent.rs` (+30 lines)
- `upstream-wezterm/patches/0028-tab-groups.md` (this file)

**Status:** Active

## What

A "group" is a logical bucket of `Tab`s identified by name. Each
`Tab` now carries an optional `group_name: Option<String>` field,
and the right-click menu gains a **"Move pane to…"** submenu that
lists the groups currently in use across all windows. Clicking
a group creates a brand-new tab in that group (sized to match
the source pane) and moves the focused pane into it. The source
tab is removed if it becomes empty.

A sentinel **"(no group)"** entry is always available in the
submenu to move a pane back into the default bucket.

The list of groups is rebuilt every time the user opens the
right-click menu, so the submenu always reflects the current
mux state. Groups with no tabs disappear from the menu
automatically (the "group vazio some" decision).

## Why

Rodrigo asked for "mover um terminal para outro grupo" (move a
terminal to another group) on 2026-06-07. Upstream wezterm does
not have any concept of tab groups in the `mux` — `Tab` only
carries a free-form `title` (verified by grep in
`mux/src/tab.rs`).

Two design decisions were made with the user:

1. **Granularity:** move a single pane, not the whole tab
   (the user said "um terminal" = one terminal).
2. **Identity:** groups are an explicit name stored on the
   `Tab`; the user rejected inferring groups from a title
   prefix (too fragile — renaming a tab silently loses the
   group).

## How the operation works

The right-click submenu is built by
`wtinator::context_menu::platform::move_pane_submenu_items`.
Each menu item gets a `w_id` derived from the lower 8 bits of
the FNV-1a hash of the group name, offset by `0x6001` — so the
address space is `0x6001..=0x60FF` (255 slots, plenty for
typical use). The sentinel "(no group)" entry occupies the
reserved slot `0x6000` and is dispatched as
`MovePaneToGroup(None)`.

The reverse mapping (wID → group name) is performed at click
time by `wtinator::context_menu::classify`, which re-enumerates
the live groups via `wtinator::groups::list_groups()` and
matches the wID. A wID that no longer matches a live group
(not possible in practice but defensive) is dropped as a no-op.

The actual move operation lives in
`wtinator::groups::move_pane_to_group(pane_id, target_group)`.
It:

1. Resolves the source pane → source tab → source window via
   `Mux::resolve_pane_id`.
2. `src_tab.remove_pane(pane_id)` to detach the pane.
3. `pane.resize(size)` so the moved pane does not briefly
   render with stale dimensions.
4. Constructs a new `Tab` sized to match the source tab, calls
   `new_tab.assign_pane(&pane)`, and applies the group name
   via `set_group_name`.
5. Adds the new tab to the mux (`add_tab_and_active_pane`)
   and to the source window (`add_tab_to_window`).
6. Removes the source tab from the mux if it is now empty
   (`is_dead`).

This is the same flow as upstream's
`Mux::move_pane_to_new_tab` (in `mux/src/lib.rs:1248`),
specialized for "create a tab in an existing group" instead of
"create a tab in a new window".

## Upstream change to `Tab`

The `mux` patch is **purely additive** — one field, two
methods:

```rust
struct TabInner {
    // ... existing fields ...
    group_name: Option<String>,  // patch 0028
}

impl Tab {
    pub fn get_group_name(&self) -> Option<String> { ... }
    pub fn set_group_name(&self, group: Option<String>) { ... }
}
```

We deliberately do **not** emit a `MuxNotification` for
`set_group_name` because the group name is a
WezTerminator-private concept and the upstream wezterm GUI
ignores it. This keeps the patch free of any new variant in
the `MuxNotification` enum.

## `Tab.group_name` survives across restarts

The save/restore of the group name is owned by
`wtinator::session` (patch 0029). This patch only adds the
in-memory API; the persistence side is a follow-up.

## Revert

1. Remove `group_name` from `TabInner` and the two methods
   from `impl Tab` in `upstream-wezterm/mux/src/tab.rs`.
2. Remove `pub mod groups;` from `wtinator/src/lib.rs` and
   delete `wtinator/src/groups.rs`.
3. Remove `NativeCommand::MovePaneToGroup`,
   `DispatchAction::MovePaneToGroup`, the `MOVE_PANE_GROUP_*`
   constants, `group_name_to_w_id`, `w_id_to_group_name`,
   and `move_pane_submenu_items` from
   `wtinator/src/context_menu.rs`. Revert the
   `full_menu_items` count in the test from 14 back to 13.
4. Remove the `MovePaneToGroup` arm in
   `wezterm-gui/src/termwindow/mouseevent.rs::schedule_native_menu`.
5. Remove this file and the row for patch 0028 from
   `PATCHES.md`.

## Risk

**Low.** The `mux` change is one field, two methods, and is
purely additive — no existing code is touched. The
`wtinator::groups` module is new code. The menu changes
extend a submenu list. The `mouseevent.rs` change is a new
`match` arm. All 62 `wtinator` tests pass, including the
new ones (`normalize_group_name_*`, `display_group_of_tab_*`,
`no_group_label_is_stable`, `group_name_to_w_id_*`) and the
updated `full_menu_includes_shells_splits_and_close` count.

The only operational risk is hash collisions in the
`0x6001..=0x60FF` wID space (two groups hashing to the same
slot). With 255 slots and typical use of 3-10 groups this is
astronomically unlikely; if it ever becomes a problem, the
fix is to widen the range into the unused `0x6xxx` space.
