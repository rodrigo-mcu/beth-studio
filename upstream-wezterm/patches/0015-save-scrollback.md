# Patch 0015 — "Save scrollback as…" in the native right-click menu

**Applied:** 2026-06-06
**Files:**
- `upstream-wezterm/wtinator/src/save_scrollback.rs` (new)
- `upstream-wezterm/wtinator/src/context_menu.rs`
- `upstream-wezterm/wtinator/src/lib.rs`
- `upstream-wezterm/wtinator/Cargo.toml`
- `upstream-wezterm/wezterm-gui/src/termwindow/mouseevent.rs`

**Status:** Active

## What

A new "Save scrollback as…" entry in the full right-click context
menu. When the user picks it:

1. The scrollback and viewport of the focused pane are read into
   a `String` (logical lines, joined with `\n`).
2. A native Win32 `GetSaveFileNameW` "Save As" dialog appears with
   a sensible default filename of the form
   `wezterm-<tab-title>-YYYYMMDD-HHMMSS.txt`.
3. After the user picks a path, a worker thread writes the text
   to the chosen file. A log line records success or failure.

The flow is fully native — no Lua callback, no upstream launcher
required. The file is plain UTF-8 text, with all the scrollback
content (visible viewport + scrollback rows, logical lines joined
with newlines).

## Why a native dialog

The upstream wezterm has a "Save tab to HTML" path in
`TermWindow::save`, but it is bound to a key assignment
(`SaveCurrentTabToHighlightedFile`) and writes the
syntax-highlighted HTML rendering, not a plain text dump of the
scrollback. A plain-text "Save scrollback" is the missing
primitive that users reach for when they want to grep the last N
minutes of a log dump from the terminal itself.

We use the Win32 `GetSaveFileNameW` common dialog rather than a
Lua launcher callback because:

- it is themed by the OS, including dark mode
- it requires no wezterm Lua config on the user's side
- it integrates with the same native-widget story that the
  right-click menu already follows (patch 0009)

## Architecture

The new module `wtinator::save_scrollback` is the sole owner of
the save flow. Its public surface is small:

```rust
pub fn collect_scrollback(pane: &Arc<dyn Pane>) -> String;
pub fn pick_path(parent_hwnd: isize, suggested_name: &str) -> Result<Option<PathBuf>>;
pub fn save_to_file(pane: Arc<dyn Pane>, parent_hwnd: isize) -> Result<Option<PathBuf>>;
```

`save_to_file` is the high-level entry point: it calls
`collect_scrollback`, then `pick_path`, then spawns a
`std::thread` to write the file. The function is synchronous
(returns once the dialog has closed), but the file write is
non-blocking because of the worker thread.

The dispatch is routed through a new
`wtinator::context_menu::DispatchAction` enum:

```rust
pub enum DispatchAction {
    Assignment(KeyAssignment),
    SaveScrollback,
}

pub fn classify(w_id: u16) -> Option<DispatchAction>;
```

`classify` is the new single-entry point used by the upstream
caller (`schedule_native_menu` in
`wezterm-gui/src/termwindow/mouseevent.rs`). It returns:

- `Some(Assignment(ka))` for the existing 0x100X / 0x200X / 0x300X
  / 0x4001-0x4003 wIDs — the upstream caller still does
  `gui_window.notify(PerformAssignment { pane_id, assignment: ka, … })`
  for these.
- `Some(SaveScrollback)` for the new wID `0x4004` — the upstream
  caller looks up the live `MuxPane` via
  `mux::Mux::get().get_pane(pane_id)` and calls
  `wtinator::save_scrollback::save_to_file(pane, hwnd)`.
- `None` for unknown wIDs.

`dispatch_native` (the old function) is kept for callers that only
need a `KeyAssignment`; the `SaveScrollback` arm in that function
returns `None` so it is never accidentally routed through the
`PerformAssignment` path.

## Threading

Everything except the file write happens on the main thread:

1. `collect_scrollback` calls `pane.get_dimensions()` and
   `pane.get_logical_lines()`. Both must be on the main thread
   (the `Pane` API is not safe to call concurrently with the
   rendering loop).
2. `GetSaveFileNameW` is modal and blocks the main thread. The
   `try_borrow_mut` guards from patch 0011 keep `WM_PAINT` and
   `WM_MOUSELEAVE` from panic-closing the GUI during the modal
   loop.
3. The file write happens on a `std::thread::Builder` thread
   named `"wtinator-save-scrollback"`. This is the only step that
   does not need to be on the main thread, and a large scrollback
   (multi-MB) would otherwise be a noticeable hitch. Errors are
   surfaced via `log::error!`.

The `wtinator` crate does not depend on `promise`, so we use
`std::thread` rather than `promise::spawn`. The work is
fire-and-forget — no follow-up notification is needed for v0.1.

## New upstream `windows-sys` features

`wtinator/Cargo.toml` gains two features on the existing
`windows-sys = "0.61"` dependency:

```
"Win32_UI_Controls",
"Win32_UI_Controls_Dialogs"
```

The `Win32_UI_Controls_Dialogs` feature is what exposes
`GetSaveFileNameW` and the `OPENFILENAMEW` struct. `Win32_UI_Controls`
is required transitively.

## Revert

1. In `wtinator/Cargo.toml`, drop the two new `windows-sys` features.
2. Delete `wtinator/src/save_scrollback.rs`.
3. In `wtinator/src/lib.rs`, remove the `pub mod save_scrollback;`
   line.
4. In `wtinator/src/context_menu.rs`:
    - Drop the `SaveScrollback` variant from `NativeCommand`.
    - Drop the `0x4004` arm in `w_id()`, `dispatch_native`, and
      `classify`.
    - Drop the `MenuEntry::Item` push in `full_menu_items()`.
    - Drop the `DispatchAction` enum, the `classify` function, and
      the `use` line for the new module (and the `SaveScrollback`
      variant, but keep `dispatch_native`).
5. In `wezterm-gui/src/termwindow/mouseevent.rs`, replace the
   `match classify(wid) { … }` block with the original
   `if let Some(action) = dispatch_native(wid) { … }` shape.
6. Drop the 4 new tests
   (`classify_routes_save_scrollback`,
    `classify_routes_known_assignments`,
    `classify_unknown_id_is_none`,
    `suggest_filename_uses_pane_title_and_extension`),
   update `full_menu_includes_shells_splits_and_close` to expect
   15 entries, and revert `all_w_ids_are_unique` to not assert on
   `SaveScrollback.w_id()`.
7. Remove this file and the row for patch 0015 from `PATCHES.md`.

## Risk

Low. The new module is self-contained and gated behind
`#[cfg(windows)]` (with a non-Windows stub). The cross-crate
changes are limited to:

- Two new `windows-sys` features in `wtinator/Cargo.toml`.
- One new `pub mod` line in `wtinator/src/lib.rs`.
- One new `DispatchAction` enum and `classify` function in
  `wtinator::context_menu`.
- One `match` rewrite in
  `wezterm-gui/src/termwindow/mouseevent.rs` (was 1 line, now
  ~15 lines but functionally equivalent for the existing wIDs).

19/19 unit tests pass (`cargo +nightly test -p wtinator`).
`wezterm.exe` and `wezterm-gui.exe` build in debug and release
with no new warnings.
