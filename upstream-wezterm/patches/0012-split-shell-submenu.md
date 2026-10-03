# Patch 0012 — Split menu asks "which terminal?" via a native Win32 submenu

**Applied:** 2026-06-06
**Files:**
- `upstream-wezterm/wtinator/src/context_menu.rs`
- `upstream-wezterm/wezterm-gui/src/termwindow/mouseevent.rs` (signature only)

**Status:** Active

## What

The "Split right" / "Split down" entries in the WezTerminator native
context menu are no longer leaves. They are now **native Win32
submenus** (`▶` cascade) that list the 6 default shells, and clicking
a shell inside the submenu dispatches a `KeyAssignment::SplitHorizontal`
/ `SplitVertical` carrying that shell's `SpawnCommand`.

The full menu (right-click on terminal pane, right-click on the `+`
button) inherits the same shape.

Concretely, in `wtinator::context_menu`:

- `NativeCommand` gains `SplitRightWithShell(usize)` and
  `SplitDownWithShell(usize)`, with stable `wID`s in the new range
  `0x3001..=0x300C` (0x3001–0x3006 = right + shells[0..5],
  0x3007–0x300C = down + shells[0..5]).
- A new `MenuEntry` enum models the menu tree:
  `MenuEntry::Item(NativeMenuItem) | Submenu { label, items } | Separator`.
- The three Windows-only builders now return `Vec<MenuEntry>` instead
  of `Vec<NativeMenuItem>`:
    - `shell_picker_items()` — 6 flat items
    - `split_picker_items()` — 2 submenus of 6 items each
    - `full_menu_items()` — 6 shell items + separator + 2 submenus +
      separator + 1 close pane
- `dispatch_native(wid)` maps the new `wID`s to
  `SplitHorizontal` / `SplitVertical` with `SpawnCommand { args, label }`
  populated from the chosen shell. Old `SplitRight` / `SplitDown`
  (0x2001 / 0x2002) are kept for the non-Windows stub path.
- `platform::show_at` now consumes `&[MenuEntry]` and uses a recursive
  `populate_hmenu` to build a sub-`HMENU` per `MenuEntry::Submenu` via
  `CreatePopupMenu` + `AppendMenuW(MF_POPUP, submenu as usize, …)`.
  Submenus are owned by the root `HMENU` and reclaimed by the root
  `DestroyMenu`.
- The non-Windows stub exposes the same `&[MenuEntry]` signature but
  always returns `None` from `show_at` (the upstream `InputSelector`
  overlay path is used in the macOS/Linux path).

In `wezterm-gui/src/termwindow/mouseevent.rs`, the only change is the
type of the `items` argument to `schedule_native_menu`: it is now
`Vec<wtinator::context_menu::MenuEntry>` (was `Vec<NativeMenuItem>`).
The three call sites (`show_native_shell_picker`,
`show_native_split_picker`, `show_native_full_menu`) already produce
that type because the builders were updated.

## Why

The user asked that the split menu "ask which terminal to open" before
splitting. Three reasonable shapes were considered:

1. **Cascading submenu (this patch)** — one mouse hover from "Split
   right" to the chosen shell; everything in a single menu open.
2. **Two-step** — clicking "Split right" shows the shell picker; the
   user picks a shell, the split happens. One extra click per split.
3. **Flat list of 12 split entries** — every (direction × shell)
   combination gets its own top-level entry. Discoverable in one
   open, but visually noisy.

The cascading submenu was chosen because it matches native Win32
convention (`▶` on the parent, 6 items in the child), keeps the parent
menu short, and reuses the existing `wID` → `KeyAssignment` dispatch
pipeline. The two-step variant was rejected because it forces a second
mouse movement and re-rendering of the menu.

## Borrow / dispatch notes

- `populate_hmenu` is recursive: a `MenuEntry::Submenu` triggers a
  child `CreatePopupMenu` and the `AppendMenuW(MF_POPUP, …)` flag.
  Submenu `HMENU`s are destroyed when the root is destroyed (Win32
  guarantees this), so there is no leak risk even on early-return
  failure.
- `populate_items_into` is the flat helper used inside a submenu —
  submenu items carry `wID`s (not further submenus), so a single
  helper is enough.
- `wID` space budget: with the new range, the highest allocated
  `wID` is `0x300C` (= 12 292), well within `u16::MAX` and the
  practical Win32 menu-item-id limit. Future patches (e.g. tabs,
  groups) can continue in the `0x4000+` range.
- `KeyAssignment::SplitHorizontal` / `SplitVertical` both take a
  `SpawnCommand`. Forwarding `args: Some(shell.args.clone())` and
  `label: Some(format!("Split — {}", shell.label))` is sufficient —
  wezterm treats unset `cwd` / `set_environment_variables` as "use
  defaults".

## Revert

To restore the flat 2-entry split picker (patch 0009 behaviour):

1. In `wtinator/src/context_menu.rs`:
    - Drop the `MenuEntry` enum and the two new `NativeCommand`
      variants.
    - Restore the `pub mod platform { ... }` signatures so the three
      builders return `Vec<NativeMenuItem>` again.
    - Restore the `pub unsafe fn show_at` body to the pre-submenu
      loop (no `populate_hmenu` recursion).
2. In `wezterm-gui/src/termwindow/mouseevent.rs`, change
   `schedule_native_menu`'s `items` argument back to
   `Vec<wtinator::context_menu::NativeMenuItem>`.
3. Drop the four new tests
   (`dispatch_native_split_with_shell_returns_split_horizontal`,
    `dispatch_native_split_with_shell_returns_split_vertical`,
    `dispatch_native_split_with_shell_all_w_ids_resolve`,
    `split_picker_items_are_2_submenus_of_6_shells`,
    `full_menu_includes_shells_splits_and_close`) and restore the
    old `split_picker_items_have_2_entries`.
4. Remove this file and the row for patch 0012 from `PATCHES.md`.

## Risk

Low. The change is contained to:

- One new public type (`MenuEntry`).
- Two new `NativeCommand` variants in a private range that no other
  module allocates from.
- A recursive `populate_hmenu` that always pairs `CreatePopupMenu`
  with a matching `DestroyMenu` (either via the parent or, on
  failure before `AppendMenuW` succeeds, explicitly).
- A single type-signature change in `mouseevent.rs`.

The 11/11 unit tests in `wtinator::context_menu::tests` pass
(`cargo +nightly test -p wtinator`), including the 4 new ones that
exercise the new wID range, submenu structure, and dispatch shape.
Both `wezterm.exe` and `wezterm-gui.exe` build in debug and release
with no new warnings.
