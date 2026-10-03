# Patch 0013 — "Copy selection" and "Paste" in the native right-click menu

**Applied:** 2026-06-06
**Files:**
- `upstream-wezterm/wtinator/src/context_menu.rs`

**Status:** Active

## What

The full context menu (right-click on terminal pane, right-click on
the `+` button) now includes two clipboard actions, placed between the
shells and the split submenus:

- `Copy selection` — `KeyAssignment::CopyTo(ClipboardAndPrimarySelection)`
- `Paste` — `KeyAssignment::PasteFrom(Clipboard)`

The structure of `full_menu_items()` is now:

```
[6 shell items]
─────────────
Copy selection
Paste
─────────────
Split right ▶
Split down ▶
─────────────
Close pane
```

## Why

The user asked the right-click menu to include "Copy" so that the
selected text in the terminal can be copied without reaching for the
keyboard. Paste is included as the natural pair: after copying from
a browser or another terminal, the user can paste it back.

Both actions are wired to upstream `KeyAssignment` variants that
already exist, so the patch is entirely contained in `wtinator`:

- `CopyTo(ClipboardCopyDestination::ClipboardAndPrimarySelection)` —
  default destination; copies to both the Win32 clipboard and the
  primary selection (no-op on Windows but the same code runs on
  X11/Wayland without further branching).
- `PasteFrom(ClipboardPasteSource::Clipboard)` — default source.

## What is *not* in this patch (and why)

The user also asked for **"Select all"** and **"Save scrollback to
file"**. Neither is in this patch:

- **Select all** — there is no `KeyAssignment::SelectAll` variant in
  the upstream enum. We do not want to silently add a new variant to
  the upstream enum from `wtinator` (that would mean modifying the
  upstream `config` crate). The user-facing workaround in this
  iteration is to add a Lua keybinding
  (`CTRL|SHIFT|A = perform_action(SelectTextAtMouseCursor(Line))` —
  but that requires a `ScrollToTop` first, which is a two-step).
  A clean implementation needs a new upstream `KeyAssignment`
  variant; tracking as a follow-up.

- **Save scrollback to file** — no `KeyAssignment` exists for "write
  the visible scrollback to a file". Implementing this requires:
  (a) a native Win32 `GetSaveFileNameW` dialog or a file-pick
  callback, and (b) reading the scrollback of the focused
  `MuxPane` (`pane.get_lines_as_escaped_strings` or similar) and
  writing it to disk. This is a larger patch (cross-cutting: needs
  to interact with the `mux` crate to read the scrollback) and is
  not just a menu wiring change. Tracked for a future iteration.

## Implementation

`NativeCommand` gains two variants:

- `CopySelection` — wID `0x4001`
- `Paste` — wID `0x4002`

Both wIDs sit in the new `0x4000+` range. With patch 0012 the highest
allocated wID was `0x300C` (12292). After patch 0013 it is `0x4002`
(16386). Both are well within `u16::MAX` (65 535) and the practical
Win32 menu-item-id limit.

`dispatch_native(wid)` maps the new wIDs to the corresponding
`KeyAssignment` with the default `ClipboardCopyDestination` /
`ClipboardPasteSource`. The function signature is unchanged.

`full_menu_items()` (Windows-only) inserts the two new items wrapped
in separators, between the shells and the split submenus. The shell
picker and the split picker are **unchanged** — this patch only
touches the full-menu composition. The non-Windows stub is unchanged.

`wezterm-gui/src/termwindow/mouseevent.rs` is **not** modified: the
existing call site
(`show_native_full_menu(self)`) already uses the new
`Vec<MenuEntry>` shape from patch 0012 and picks up the new items
automatically.

## Revert

To drop Copy / Paste from the full menu:

1. In `wtinator/src/context_menu.rs`:
    - Remove the `CopySelection` and `Paste` `NativeCommand`
      variants, the `0x4001` / `0x4002` arms in `w_id()`, the
      `0x4001` / `0x4002` arms in `dispatch_native`, and the
      `CopyTo(...)` / `PasteFrom(...)` arms in the dispatch match.
    - Remove the two `MenuEntry::Item` pushes (and one of the two
      adjacent separators) from `full_menu_items()`.
2. Drop the two new tests
   (`dispatch_native_copy_selection_returns_copy_to`,
    `dispatch_native_paste_returns_paste_from`) and revert
    `full_menu_includes_shells_splits_and_close` to expect 11
    entries again.
3. Remove this file and the row for patch 0013 from `PATCHES.md`.

## Risk

Low. The change is contained to `wtinator::context_menu`:

- Two new `NativeCommand` variants in a private range that no other
  module allocates from.
- Two new `dispatch_native` arms that reuse existing
  `KeyAssignment` constructors.
- Two new `MenuEntry::Item` pushes in the full-menu builder.
- Two new unit tests, plus a count update on the existing
  `full_menu_includes_shells_splits_and_close` test.

13/13 unit tests pass (`cargo +nightly test -p wtinator`).
`wezterm.exe` and `wezterm-gui.exe` build in debug and release with
no new warnings.
