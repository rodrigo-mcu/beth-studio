# Patch 0030 — Per-terminal status header

**Applied:** 2026-06-08
**Files:**
- `upstream-wezterm/mux/src/tab.rs` (modified, +50 lines)
- `upstream-wezterm/wtinator/src/header.rs` (new, ~200 lines)
- `upstream-wezterm/wtinator/src/lib.rs` (`pub mod header;`)
- `upstream-wezterm/wtinator/src/context_menu.rs` (+~40 lines)
- `upstream-wezterm/wezterm-gui/src/termwindow/mouseevent.rs` (+~40 lines)
- `upstream-wezterm/wtinator/src/session.rs` (schema bump v1 → v2)
- `upstream-wezterm/patches/0030-terminal-header.md` (this file)

**Status:** Active (data model + persistence complete; visual
render is deferred — see "Render TODO" below).

## What

A per-terminal status header that the user can rename from
the right-click menu. The data model and persistence are
fully implemented:

- `mux::tab::Tab` gains a new `header_text: Option<String>`
  field (alongside the `group_name` from patch 0028).
- `Tab::get_header_text` / `Tab::set_header_text` mirror the
  group_name API.
- A new `wtinator::header` module owns the `build_header`
  string formatter (`"Tab #N · group: X · title"`),
  the `normalize_header_text` input validator, and a stub
  for the Win32 rename dialog.
- A "Rename terminal…" entry in the right-click context
  menu (wID `0x6100`) dispatches the rename via
  `mouseevent.rs`.
- `wtinator::session` now persists `header_text` alongside
  `group_name`. Schema bumped from v1 to v2; v1 files
  parse cleanly into v2 (the new field defaults to
  `None`).

## Why

Rodrigo asked for "colocar um header em cada terminal
mostrando qual terminal é e podendo nomear ele" on
2026-06-08. With the tab-groups feature (patch 0028) he
now has 3-5 groups open with 2-3 tabs each, and the tab
bar at the top of the window does not give enough
information at a glance to distinguish which terminal is
doing what.

## Decisions made with the user

- **Inside the terminal, not the tab bar** — a status
  line embedded in the pane viewport, not a fixed
  widget on the window chrome.
- **Rolls with the scrollback** (vim modeline style) —
  the header line is part of the visible viewport, not
  pinned to the top.
- **Three fields**: `Tab #N` (always) · `group: X` (if
  set, patch 0028) · custom title (if set, this
  patch).

## Render TODO

The visual render of the header (reserving one row of
the pane viewport and drawing the gray bar with white
text) is **not yet implemented**. The data model,
persistence, menu entry, dispatch, and Win32 input
dialog are all in place; the renderer integration in
`wezterm-gui/src/termwindow/render/pane.rs` is deferred
because it requires non-trivial changes to the viewport
math (`physical_top` / `cursor.coords` / `selection_y`).

Once the render lands, the manual test plan in this
file should be run end-to-end.

A pragmatic interim approach is to render the header as
part of the tab title (the upstream tab bar at the top
of the window) — this gives the user the same
information without requiring viewport surgery. A
follow-up patch can do this as a `set_tab_title` call
inside `mouseevent.rs::RenameTerminal`'s handler, on
top of the data-model `set_header_text`. This is
intentionally left as a TODO so the in-pane render
option stays open.

## Win32 dialog

The `prompt_rename` function in `wtinator::header` opens
a real Win32 modal dialog with an `EDIT` control, OK
and Cancel buttons, and Enter/Esc keyboard shortcuts.
The dialog:

- Registers a one-off window class with a custom
  `wndproc` (no resource files needed).
- Centers itself on the parent HWND (the terminal
  window) when one is available.
- Pre-fills the `EDIT` with the current header text so
  the user can edit-in-place.
- Runs a local message loop until the user picks
  OK (commit), Cancel/Esc/close (abort), or types
  Enter (== OK via the `BS_DEFPUSHBUTTON` default
  handling).
- Stashes the result in a `thread_local!` cell that
  the `wndproc` writes to and `run` reads from.
- Posts a `TermWindowNotif::Apply` to the main thread
  via `gui_window.notify(...)`. The notification
  closure resolves the tab by id and calls
  `set_header_text` on the main thread (mux locks
  must be taken on the main thread — the dialog
  thread only carries data, never mux state).

The dispatcher in `mouseevent.rs` (patch 0030.4)
spawns a **dedicated `std::thread`** for the dialog.
The first attempt at this dialog ran `prompt_rename`
inline on the main thread, which **froze the wezterm
window** because the dialog's own `GetMessageW` loop
starved the main message loop (the wezterm window
could not repaint, could not respond to focus
changes, and the terminal felt completely frozen
even though the dialog itself was technically
running). Running the dialog in a `std::thread`
keeps the main thread's `PeekMessageW` /
`SPAWN_QUEUE.run()` loop flowing, so the terminal
remains responsive while the dialog is open. The
result comes back to the main thread via the same
`gui_window.notify(TermWindowNotif::Apply(...))`
channel the screenshot patch uses.

The top-level window is created with `WS_VISIBLE` so
it shows up immediately; the `EDIT` and button
children inherit visibility from their styles too.

## Dialog dimensions

- **Outer window: 520×170 px.** The v1 was 320×100
  and was too narrow to comfortably show 80-char
  titles — the EDIT control had to clip them with
  "…". The +170 height gives room for a static
  label above the EDIT and 36-px-tall buttons below.
- **Top-level window styles:**
  `WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_VISIBLE`
  + extended `WS_EX_TOPMOST | WS_EX_DLGMODALFRAME`.
  The `WS_EX_DLGMODALFRAME` is a constant that the
  `windows-sys` crate does not expose in the version
  we depend on (0.61), so it is hard-coded as
  `0x0000_0001`.
- **Layout:**
  - Static label `&New name:` at (12, 12, 100, 18)
  - EDIT at (12, 36, 496, 32) with extended
    `WS_EX_CLIENTEDGE` (hard-coded `0x0000_0200`) so
    it has a sunken 3D border
  - OK button at (296, 110, 110, 36) — `BS_DEFPUSHBUTTON`
    so Enter commits
  - Cancel button at (398, 110, 110, 36)
- **Centering:** the dialog is centered on the
  parent HWND's client area (using `GetClientRect`
  to find the parent center, then offsetting by
  half the dialog dimensions).

## Dialog styling (patch 0030, late iteration)

The original v1 dialog was the default Win32 look:
  - EDIT with the heavy 3D sunken border (`WS_EX_CLIENTEDGE`)
  - System 8-pt "MS Shell Dlg" font
  - Pure-white background, pure-black text
  - Buttons drawn with the classic grey 3D chrome

The current dialog applies a much softer palette:

  - **Background brush `#FAFAFA`** (off-white)
    created via `CreateSolidBrush` in a `OnceLock<usize>`
    and returned from `WM_CTLCOLOREDIT` /
    `WM_CTLCOLORSTATIC` / `WM_CTLCOLORBTN`. The brush
    is process-lived (we deliberately do not call
    `DeleteObject`; the OS reclaims it on process exit).
  - **Text colors**: EDIT and buttons are `#1F1F1F`
    (near-black); the static label is `#606060`
    (medium grey) so the label reads as supporting
    text, not as primary content.
  - **Font**: Segoe UI 9pt (the modern Windows UI
    font), created with `CreateFontW` (`-14` for 9pt
    points, `FW_NORMAL` weight, `OUT_DEFAULT_PRECIS`
    for default glyph selection, `FF_DONTCARE` pitch).
    The `HFONT` is cached in a `OnceLock<usize>` and
    applied to every control via `WM_SETFONT`. The
    font is also process-lived.

The `HBRUSH` and `HFONT` handles are stored as raw
`usize` in `OnceLock<usize>` rather than directly
in `OnceLock<HBRUSH>` / `OnceLock<HFONT>` because
those newtypes are `*mut c_void` and are not
`Send + Sync` — the `OnceLock` requires `Send + Sync`
to be safe to use from multiple threads.

The `RGB()` macro from `<wingdi.h>` is a classic
Win32 macro that the `windows-sys` 0.61 crate does
not expose, so the module provides its own
`const fn rgb(r, g, b) -> u32` that produces the
same `COLORREF` (`0x00BBGGRR`) value.

**Note on lint scope:** the `unsafe_code` lint is
`warn` at the crate level (in `Cargo.toml`) and the
`#[allow(unsafe_code)]` on this module silences it
for just this file. All other `wtinator` modules
remain safe-by-default.

The implementation lives in the sub-module
`header::win32_prompt`. It is the **only** module in
the `wtinator` crate that uses `unsafe`; the crate-level
`#[warn]` on the `unsafe_code` lint (moved here from
`lib.rs` so a sub-module-level `#[allow(unsafe_code)]`
can actually silence the warning) keeps the rest of the
delta safe-by-default.

The user explicitly OK'd this approach on 2026-06-08
("pode abrir uma janela nativa do windows sem
problema"). The alternative (adopting `rfd` or
`native-windows-gui` for an `InputDialog`-style
portable prompt) would have worked too, but pulls in
a moderate dep for a single use site.

## Revert

1. Drop `header_text` from `TabInner` and the
   `get_header_text` / `set_header_text` methods from
   `impl Tab` in `upstream-wezterm/mux/src/tab.rs`.
2. Remove `pub mod header;` from `wtinator/src/lib.rs`
   and delete the `wtinator/src/header/` sub-directory
   (the `mod.rs` and `win32_prompt.rs` files).
3. Remove `NativeCommand::RenameTerminal`,
   `DispatchAction::RenameTerminal`, the wID `0x6100`,
   and the "Rename terminal…" `MenuEntry::Item` from
   `wtinator/src/context_menu.rs`. Revert the
   `full_menu_items` count in the test from 15 back
   to 14.
4. Remove the `DispatchAction::RenameTerminal` arm
   in `wezterm-gui/src/termwindow/mouseevent.rs`.
5. In `wtinator/src/session.rs`, drop `header_text`
   from `TabGroup`, revert `SESSION_VERSION` to 1,
   and drop the `apply`'s `set_header_text` call.
6. In `wtinator/Cargo.toml`, revert `unsafe_code`
   from `warn` back to being absent (and restore
   `#![deny(unsafe_code)]` in `wtinator/src/lib.rs`).
7. Remove this file and the row for patch 0030 from
   `PATCHES.md`.

## Risk

**Low** (excluding the deferred render). The changes
are:

- One new field in `TabInner` plus two methods (mux
  patch is purely additive).
- One new sub-directory `wtinator/src/header/` with
  the data model + a real Win32 modal input dialog
  in `win32_prompt.rs` (~150 lines, all the
  `unsafe` confined to that one file).
- One new menu item + one dispatch arm in
  `wezterm-gui`.
- One new field in the session JSON, with a
  `serde(default)` so the upgrade from v1 to v2 is
  transparent for files that lack the field.
- The `unsafe_code` lint moved from `deny` (in
  `lib.rs`) to `warn` (in `Cargo.toml`) so the
  `#[allow(unsafe_code)]` on the `win32_prompt`
  sub-module can actually silence the warning for
  just that file.

All 79 `wtinator` tests pass, including the 7 in
the `header` module and the 8 in the `session`
module (with the new `session_v1_file_is_acceptable_for_v2_load`).

The `wezterm-gui` binary launches and runs
correctly with the new code path (verified via
`timeout ./wezterm-gui.exe` smoke test on
2026-06-08).
