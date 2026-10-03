# Patch 0009 — Native Win32 context menu (HMENU)

**Applied:** 2026-06-06
**Files:**
- `upstream-wezterm/wezterm-gui/src/termwindow/mouseevent.rs` (multiple sites)
- `upstream-wezterm/wezterm-gui/Cargo.toml` (`[dependencies]`)

**Status:** Active

## What

Three mouse-driven entry points in the upstream `wezterm-gui` mouse
handler are rewired to show a **native Win32 popup menu** instead of
the upstream Skia `InputSelector` overlay:

1. **Right-click on a terminal pane** — was (patch 0005) an
   `InputSelector` overlay; now (patch 0009) a native HMENU.
2. **Left-click on the `+` button** on the tab bar — was (patch 0006)
   an `InputSelector` overlay; now a native HMENU.
3. **Right-click on the `+` button** — was (patch 0006) a full-menu
   `InputSelector`; now a native HMENU.
4. **Left-click on the `[>_]` terminal icon** on the tab bar — was (patch
   0007) an `InputSelector` overlay; now a native HMENU.

The new path goes through `wtinator::context_menu::platform::show_at`
which calls Win32 `CreatePopupMenu` + `AppendMenuW` + `TrackPopupMenuEx`.

The HWND is obtained with `GetForegroundWindow()` (a global OS call
that does not require any borrow on the wezterm-gui internals) — see
"Borrow workaround" below.

The menu items are built in `wtinator/src/context_menu.rs` in the
`platform` submodule (Windows-only via `cfg(windows)`). Three item
lists are exposed:

| Function | Items |
| --- | --- |
| `shell_picker_items()` | 6 items: Open cmd.exe / PowerShell 5.1 / PowerShell 7+ / WSL (default distro) / WSL — Ubuntu / Git Bash |
| `split_picker_items()` | 2 items: Split right / Split down |
| `full_menu_items()` | 6 shells + separator + 2 splits + separator + 1 close pane |

After the user clicks an item, `TrackPopupMenuEx` returns the `wID`
we set in `AppendMenuW`. We map `wID -> KeyAssignment` via
`wtinator::context_menu::dispatch_native(wid)` and then call
`TermWindow::perform_key_assignment(pane, &action)`.

## Why

We initially used the upstream `config::keyassignment::InputSelector`
overlay, which is a Skia popup rendered **inside the wezterm-gui
window**. The user reported that the overlay did not appear for them
in their Windows session (it was occluded or not rendered at all in
some graphics environments).

The native Win32 HMENU solves this because:

- It is a real Windows control — the same widget you see when
  right-clicking on any application
- It is themed by the OS (light/dark/high-contrast)
- It is **always on top** of the wezterm window
- It is positioned at the cursor by `TrackPopupMenuEx`
- It is **always visible**, regardless of the wezterm-gui graphics
  state

## Borrow workaround

The first attempt to get the HWND was to call
`window::Window::raw_window_handle()`. This **panicked** with
`RefCell already mutably borrowed` at
`window/src/os/windows/window.rs:752` because the mouse-event
dispatch happens inside a callback (`dispatch_window_event`) that
already holds a mutable borrow of the inner `Window` (via
`apply_theme` / `wm_paint` running in the same stack).

The fix is to **not** call `raw_window_handle()`. Instead, the popup
is shown with the HWND of `GetForegroundWindow()`. Since the popup
is being shown *in response to* a user click, the foreground window
is always the wezterm-gui (we just forced it via
`SetForegroundWindow` in the patch 0006/0009 path). The downside is
that this is a global OS query; in the unusual case where the
foreground is some other wezterm window, the popup attaches to that
window. That is acceptable — the popup is still visible to the user.

## Migration notes (from the Skia overlay path)

- Old API: `wtinator::context_menu::build_shell_picker()` /
  `build_split_picker()` / `build_full_menu()` returned
  `config::keyassignment::InputSelector` (consumed by
  `TermWindow::show_input_selector`).
- New API: `wtinator::context_menu::platform::shell_picker_items()` /
  `split_picker_items()` / `full_menu_items()` return
  `Vec<NativeMenuItem>`, and
  `wtinator::context_menu::platform::show_at(hwnd, x, y, &items)`
  shows the native menu.
- Dispatch: old `dispatch(id)` -> `KeyAssignment`; new
  `dispatch_native(wid) -> KeyAssignment` (the same shape, but
  the `wID` is a `u16` instead of a `&str`).

The old builders are kept (marked `#[allow(dead_code)]` /
`#[cfg(windows)]` for the non-Windows stub) so that:
- Test code can still exercise the menu structure.
- macOS / Linux users (when we add support) can fall back to the
  InputSelector overlay if we don't have a native menu on those
  platforms.

## Revert

To restore the Skia overlay path:

1. In each of the four handler sites, replace the
   `show_native_*_menu(self)` call with the corresponding
   `let menu = wtinator::context_menu::build_*_picker(); self.show_input_selector(&menu); return;`
   pair.
2. Remove the `windows-sys` dep from `wezterm-gui/Cargo.toml`.
3. Remove the four `show_native_*_menu` functions from the bottom
   of `mouseevent.rs`.

## Risk

Low. The native menu is a well-understood Win32 idiom. The HWND
lookup is the only novel part; `GetForegroundWindow` is a documented
Win32 API and does not fail (it returns the foreground window of
the calling thread).
