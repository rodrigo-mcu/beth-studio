# Patch 0010 - native menus open outside mouse callbacks

**Applied:** 2026-06-06
**Documented by:** Codex gpt-5.5
**Files:**
- `upstream-wezterm/wezterm-gui/src/termwindow/mouseevent.rs`
- `upstream-wezterm/wtinator/src/context_menu.rs`

**Status:** Active

## What

Right-click on a terminal pane now consumes the button-down event and
opens the native Win32 menu only on button-up:

```rust
match event.kind {
    WMEK::Press(MousePress::Right) => return,
    WMEK::Release(MousePress::Right) => {
        show_native_full_menu(self);
        return;
    }
    _ => {}
}
```

The Win32 menu flags also no longer include `TPM_RIGHTBUTTON`; menu
items are selected with the normal left-button activation path after
the popup is already visible.

The native menu is also no longer shown directly from
`dispatch_window_event`. The mouse handler captures the active
`pane_id`, defers work with `promise::spawn::spawn_into_main_thread`,
opens `TrackPopupMenuEx` after the current window callback has returned,
and then dispatches the selected action with:

```rust
gui_window.notify(TermWindowNotif::PerformAssignment {
    pane_id,
    assignment: action,
    tx: None,
});
```

This path logs `wezterminator patch 0010` before scheduling and from
the deferred main-thread task so crash logs show whether the fixed code
path was actually used.

Do not move `TrackPopupMenuEx` to a helper thread. That experiment stopped
the panic but made every native menu entry point stop working: terminal
pane right-click, the `+` button, and the tab-bar terminal icon. The working
shape is "defer out of the current mouse callback, then show the HMENU on
the UI/main thread".

## Why

Patch 0009 showed the native `HMENU` from the terminal pane's
`RightPress` event. On Windows, `TrackPopupMenuEx` enters a modal menu
loop immediately. If the menu is shown while the right mouse button is
still held, the matching button-up can be interpreted as a menu
selection.

That is especially dangerous near the bottom of the screen, where
Windows may position the menu upward and leave the cursor over the last
menu item. In the full menu the last item is `Close pane`; selecting it
in a single-pane window can close the visible application, which looks
like "right-click closed the app".

Showing the menu on release matches normal context-menu behavior and
prevents the same click from both opening and activating the menu.

The extra main-thread scheduling avoids a second failure mode seen in
the logs:

```text
panic at window\src\os\windows\window.rs:1889:27
core::cell::panic_already_borrowed
...
NtUserTrackPopupMenuEx
wtinator::context_menu::platform::show_at
wezterm_gui::termwindow::mouseevent::show_native_full_menu
<wezterm_gui::termwindow::TermWindow>::dispatch_window_event
```

`TrackPopupMenuEx` runs a nested Win32 modal loop. While that loop is
open, Windows can send `WM_PAINT` or `WM_MOUSELEAVE` to the same
window. Showing the menu directly inside `dispatch_window_event` means
those reentrant messages try to mutably borrow `window::WindowInner`
while the original callback still holds the borrow. Rust correctly
panics instead of allowing aliased mutable access.

Patch 0010 still needs patch 0011. Deferring to the main thread prevents
the original callback from holding the borrow, but `TrackPopupMenuEx` still
enters a nested Win32 modal loop. Patch 0011 guards the reentrant paint and
mouse-leave paths that Windows may deliver while that modal loop is open.

## Revert

To revert:

1. In `mouse_event_terminal`, restore the patch 0009 behavior:
   show `show_native_full_menu(self)` directly from
   `WMEK::Press(MousePress::Right)`.
2. Add `TPM_RIGHTBUTTON` back to the import list and the
   `TrackPopupMenuEx` flag set in `wtinator::context_menu::platform::show_at`.
3. Replace the deferred `show_native_*` implementation with
   the direct `show_at` + `perform_key_assignment` implementation.

## Risk

Low. The right-button down event is still consumed, so terminal
applications do not receive a stray right-click. The only visible
behavior change is that the context menu appears after button release
instead of button press.
